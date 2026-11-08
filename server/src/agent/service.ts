import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import type { AgentProposalRow } from '../db/types';
import { conflict, forbidden, invalid, notFound } from '../errors';
import { createAssignment, type Actor } from '../services/assignments';
import { queueStatusUpdate } from '../services/outbox';
import { addEvent, getRowOrThrow } from '../services/sosView';
import { currentProposal, proposalDto, publishUpdated, runDto, runSummaryDto } from './store';

type Decision = components['schemas']['AgentProposalDecision'];

function requireStaff(actor: Actor) {
  if (actor.role === 'volunteer') throw forbidden('Volunteers cannot use the dispatch agent');
}

export async function getLatestRun(ctx: Ctx, sosId: string, actor: Actor) {
  requireStaff(actor);
  await getRowOrThrow(ctx, sosId);
  const r = await ctx.db.selectFrom('agent_runs').selectAll().where('sos_id', '=', sosId).where('status', '!=', 'cancelled').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  if (!r) throw notFound('No agent run for this case');
  return runDto(ctx, r);
}

export async function listRuns(ctx: Ctx, sosId: string, actor: Actor, limit = 20) {
  requireStaff(actor);
  await getRowOrThrow(ctx, sosId);
  const runs = await ctx.db.selectFrom('agent_runs').selectAll().where('sos_id', '=', sosId).orderBy('created_at', 'desc').limit(Math.min(limit, 50)).execute();
  const props = runs.length ? await ctx.db.selectFrom('agent_proposals').select(['run_id', 'status']).where('run_id', 'in', runs.map((r) => r.id)).execute() : [];
  const by = new Map(props.map((p) => [p.run_id, p.status]));
  return { data: runs.map((r) => runSummaryDto(r, by.get(r.id) ?? null)) };
}

export async function manualRun(ctx: Ctx, sosId: string, actor: Actor) {
  requireStaff(actor);
  await getRowOrThrow(ctx, sosId);
  if (!ctx.agent.enabled()) throw conflict('The dispatch agent is disabled on this server');
  const run = await ctx.agent.trigger(sosId, 'manual');
  if (!run) throw conflict('The case is not open, so there is nothing to assess');
  return runDto(ctx, run);
}

import { broadcastSos } from '../services/sosView';

async function loadProposal(ctx: Ctx, sosId: string, proposalId: string): Promise<AgentProposalRow> {
  const p = await ctx.db.selectFrom('agent_proposals').selectAll().where('id', '=', proposalId).where('sos_id', '=', sosId).executeTakeFirst();
  if (!p) throw notFound('Proposal not found');
  if (p.status === 'proposed' && Date.now() - p.created_at.getTime() >= ctx.cfg.AGENT_PROPOSAL_TTL_S * 1000) {
    await ctx.db.updateTable('agent_proposals').set({ status: 'expired', updated_at: new Date() }).where('id', '=', p.id).where('status', '=', 'proposed').execute();
    p.status = 'expired';
    await publishUpdated(ctx, p.run_id);
    await broadcastSos(ctx, 'sos.updated', sosId);
  }
  return p;
}

export async function approveProposal(ctx: Ctx, sosId: string, proposalId: string, b: { eta_minutes?: number; note?: string; send_victim_message?: boolean; responder_id?: string }, actor: Actor): Promise<Decision> {
  requireStaff(actor);
  await getRowOrThrow(ctx, sosId);
  const p = await loadProposal(ctx, sosId, proposalId);
  const responderId = p.responder_id ?? (actor.role === 'admin' ? b.responder_id ?? null : null);
  if (actor.role !== 'admin' && p.responder_id !== actor.id) throw forbidden('Only an admin or the responder named in the proposal can approve it');
  if (p.status !== 'proposed') throw conflict(`Proposal is already ${p.status}`, { status: p.status });
  if (!responderId) throw invalid('This proposal names no responder; an admin must pass responder_id', { responder_id: 'required' });
  const now = new Date();
  // conditional UPDATE = the arbiter between two simultaneous approvals
  const won = await ctx.db.updateTable('agent_proposals').set({ status: 'approved', decided_by: actor.id, decided_at: now, decision_note: b.note?.trim() || null, responder_id: responderId, updated_at: now })
    .where('id', '=', p.id).where('status', '=', 'proposed').returning('id').executeTakeFirst();
  if (!won) throw conflict('Proposal was decided by someone else', { status: 'approved' });
  let assignment;
  try {
    assignment = await createAssignment(ctx, { sos_id: sosId, responder_id: responderId, eta_minutes: b.eta_minutes ?? p.eta_minutes ?? undefined }, actor);
  } catch (e) {
    await ctx.db.updateTable('agent_proposals').set({ status: 'proposed', decided_by: null, decided_at: null, decision_note: null, responder_id: p.responder_id, updated_at: new Date() }).where('id', '=', p.id).execute();
    throw e;
  }
  if (b.send_victim_message && p.victim_message) await queueStatusUpdate(ctx, sosId, new Date(), p.victim_message); // only after the assignment succeeded
  await addEvent(ctx.db, sosId, 'agent_approved', { kind: 'responder', id: actor.id }, { proposal_id: p.id, assignment_id: assignment.id, victim_message_sent: !!(b.send_victim_message && p.victim_message) });
  if (b.note?.trim()) await addEvent(ctx.db, sosId, 'note', { kind: 'responder', id: actor.id }, { text: b.note.trim(), proposal_id: p.id });
  await publishUpdated(ctx, p.run_id);
  const fresh = await loadProposal(ctx, sosId, p.id);
  return { proposal: await proposalDto(ctx, fresh), assignment };
}

export async function rejectProposal(ctx: Ctx, sosId: string, proposalId: string, b: { reason?: string }, actor: Actor) {
  requireStaff(actor);
  await getRowOrThrow(ctx, sosId);
  const p = await loadProposal(ctx, sosId, proposalId);
  if (actor.role !== 'admin' && p.responder_id && p.responder_id !== actor.id) throw forbidden('Only an admin or the responder named in the proposal can reject it');
  if (p.status !== 'proposed') throw conflict(`Proposal is already ${p.status}`, { status: p.status });
  const now = new Date();
  const won = await ctx.db.updateTable('agent_proposals').set({ status: 'rejected', decided_by: actor.id, decided_at: now, decision_note: b.reason?.trim() || null, updated_at: now })
    .where('id', '=', p.id).where('status', '=', 'proposed').returning('id').executeTakeFirst();
  if (!won) throw conflict('Proposal was decided by someone else');
  await addEvent(ctx.db, sosId, 'agent_rejected', { kind: 'responder', id: actor.id }, { proposal_id: p.id, reason: b.reason?.trim() || null });
  await publishUpdated(ctx, p.run_id);
  return proposalDto(ctx, (await loadProposal(ctx, sosId, p.id)));
}

export { currentProposal };
