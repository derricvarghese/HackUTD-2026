import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import type { AgentProposalRow, AgentRunRow } from '../db/types';
import type { Step } from './loop';

export type AgentRunDto = components['schemas']['AgentRun'];
export type AgentRunSummaryDto = components['schemas']['AgentRunSummary'];
export type AgentProposalDto = components['schemas']['AgentProposal'];

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function proposalDto(ctx: Ctx, p: AgentProposalRow): Promise<AgentProposalDto> {
  const names = new Map<string, string>();
  const ids = [p.responder_id, p.decided_by].filter((x): x is string => !!x);
  if (ids.length) for (const r of await ctx.db.selectFrom('responders').select(['id', 'name']).where('id', 'in', ids).execute()) names.set(r.id, r.name);
  return {
    id: p.id, run_id: p.run_id, sos_id: p.sos_id, kind: 'dispatch', responder_id: p.responder_id, responder_name: p.responder_id ? names.get(p.responder_id) ?? null : null,
    eta_minutes: p.eta_minutes, equipment: (p.equipment as string[]) ?? [], facility: (p.facility as AgentProposalDto['facility']) ?? null, victim_message: p.victim_message, notes: p.notes,
    status: p.status, decided_by: p.decided_by, decided_at: iso(p.decided_at), decision_note: p.decision_note, created_at: p.created_at.toISOString(),
  };
}

export async function currentProposal(ctx: Ctx, sosId: string): Promise<AgentProposalRow | undefined> {
  const p = await ctx.db.selectFrom('agent_proposals').selectAll().where('sos_id', '=', sosId).where('status', '!=', 'superseded').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  if (p && p.status === 'proposed' && Date.now() - p.created_at.getTime() >= ctx.cfg.AGENT_PROPOSAL_TTL_S * 1000) {
    await ctx.db.updateTable('agent_proposals').set({ status: 'expired', updated_at: new Date() }).where('id', '=', p.id).where('status', '=', 'proposed').execute();
    p.status = 'expired';
  }
  return p;
}

export async function runDto(ctx: Ctx, r: AgentRunRow, proposal?: AgentProposalRow | null): Promise<AgentRunDto> {
  const p = proposal === undefined ? await currentProposal(ctx, r.sos_id) : proposal;
  return {
    id: r.id, sos_id: r.sos_id, status: r.status, trigger: r.trigger as AgentRunDto['trigger'], model: r.model, created_at: r.created_at.toISOString(), started_at: iso(r.started_at), finished_at: iso(r.finished_at),
    duration_ms: r.duration_ms, steps: (r.steps as Step[]) ?? [], assessment: (r.assessment as AgentRunDto['assessment']) ?? null, error: r.error, tokens: (r.tokens as AgentRunDto['tokens']) ?? null,
    proposal: p ? await proposalDto(ctx, p) : null,
  };
}

export function runSummaryDto(r: AgentRunRow, proposalStatus: string | null): AgentRunSummaryDto {
  const a = r.assessment as { summary?: string; confidence?: string } | null;
  return {
    id: r.id, status: r.status, trigger: r.trigger, model: r.model, created_at: r.created_at.toISOString(), finished_at: iso(r.finished_at), duration_ms: r.duration_ms,
    step_count: ((r.steps as unknown[]) ?? []).length, summary: a?.summary ?? null, confidence: (a?.confidence as AgentRunSummaryDto['confidence']) ?? null, error: r.error,
    proposal_status: (proposalStatus as AgentRunSummaryDto['proposal_status']) ?? null,
  };
}

/** WebSocket frames: public/safe fields only (no coordinates, names or free text from the case). Volunteers get nothing. */
export function publishStep(ctx: Ctx, runId: string, sosId: string, s: Step) {
  const data = { run_id: runId, sos_id: sosId, index: s.index, type: s.type, tool: s.tool, summary: s.summary, ok: s.ok, ms: s.ms, synthetic: !!s.synthetic };
  ctx.hub.publish('agent.step', (v) => (v.role === 'volunteer' ? undefined : data));
}

export async function publishUpdated(ctx: Ctx, runId: string) {
  const r = await ctx.db.selectFrom('agent_runs').selectAll().where('id', '=', runId).executeTakeFirst();
  if (!r) return;
  const p = await currentProposal(ctx, r.sos_id);
  const data = {
    run_id: r.id, sos_id: r.sos_id, status: r.status, trigger: r.trigger, summary: (r.assessment as { summary?: string } | null)?.summary ?? null,
    confidence: (r.assessment as { confidence?: string } | null)?.confidence ?? null, duration_ms: r.duration_ms, finished_at: iso(r.finished_at), error: r.error ? r.error.slice(0, 120) : null,
    proposal: p ? await proposalDto(ctx, p) : null,
  };
  ctx.hub.publish('agent.updated', (v) => (v.role === 'volunteer' ? undefined : data));
}
