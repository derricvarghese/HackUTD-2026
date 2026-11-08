import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '../api/endpoints';
import { ApiError } from '../api/client';
import type { AgentProposal, AgentRun, AgentStep, Responder, Sos } from '../api/models';
import { errorMessage, invalidateCase, qk, useCaseAgent } from '../hooks/data';
import { formatKm } from '../lib/units';
import { formatDateTime } from '../lib/time';
import { useUi } from '../state/ui';

export interface AgentPanelProps {
  sosId: string;
  caseData: Sos;
  isAdmin: boolean;
  canAct: boolean;
  responders: Responder[];
}

export function AgentPanel({ sosId, caseData, isAdmin, canAct, responders }: AgentPanelProps) {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const agentQuery = useCaseAgent(sosId, canAct);
  const run: AgentRun | undefined = agentQuery.data;

  // Re-run mutation
  const [running, setRunning] = useState(false);
  const handleReRun = async () => {
    try {
      setRunning(true);
      await api.runCaseAgent(sosId);
      toast('success', 'Dispatch agent triggered');
      invalidateCase(qc, sosId);
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  // Group steps by turn
  const turns = useMemo(() => {
    if (!run?.steps || !run.steps.length) return [];
    const map = new Map<number, AgentStep[]>();
    for (const step of run.steps) {
      const turn = step.turn ?? 0;
      if (!map.has(turn)) map.set(turn, []);
      map.get(turn)!.push(step);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a - b);
  }, [run?.steps]);

  const proposal = run?.proposal;
  const isAgentActive = run?.status === 'queued' || run?.status === 'running' || running;

  return (
    <div className="agent-panel" data-testid="agent-panel">
      {/* Header with status and re-run */}
      <div className="agent-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>Dispatch Agent</span>
            {run?.status && (
              <span className={`aichip agent ${run.status === 'running' ? 'pending pulse' : run.status === 'queued' ? 'pending' : run.status === 'failed' ? 'failed' : 'complete'}`}>
                {run.status}
              </span>
            )}
          </h3>
          {run?.model && <small className="muted" style={{ fontSize: 11 }}>Model: {run.model}</small>}
        </div>
        {canAct && caseData.status !== 'resolved' && (
          <button
            className="btn sm"
            disabled={isAgentActive}
            onClick={handleReRun}
            title="Re-run the dispatch agent now"
          >
            {isAgentActive ? 'Assessing…' : 'Re-run Agent'}
          </button>
        )}
      </div>

      {agentQuery.isLoading && <div className="skel" style={{ height: 120, marginBottom: 16 }} />}

      {agentQuery.isError && (
        <p className="note" style={{ color: 'var(--muted)' }}>
          {run === undefined ? 'No agent run for this case yet.' : 'Could not load agent details.'}
        </p>
      )}

      {/* Proposal Card */}
      {proposal && (
        <ProposalCard
          proposal={proposal}
          sosId={sosId}
          isAdmin={isAdmin}
          canAct={canAct}
          responders={responders}
        />
      )}

      {/* Assessment Card */}
      {run?.assessment && (
        <div className="card agent-card" style={{ marginBottom: 14, padding: '12px 14px' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>
            Assessment & Findings
          </h4>
          <p style={{ margin: '0 0 10px', fontSize: 13.5, lineHeight: 1.45, fontWeight: 500 }}>
            {run.assessment.summary}
          </p>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10, fontSize: 12 }}>
            <span><strong>Confidence:</strong> {run.assessment.confidence}</span>
            {run.assessment.score_effect && (
              <span style={{ color: 'var(--blue)' }}>
                <strong>Score Effect:</strong> {run.assessment.score_effect.score_before} → {run.assessment.score_effect.score_after}{' '}
                ({run.assessment.score_effect.applied_delta >= 0 ? `+${run.assessment.score_effect.applied_delta}` : run.assessment.score_effect.applied_delta})
              </span>
            )}
          </div>

          {/* Evidence findings */}
          {run.assessment.evidence && run.assessment.evidence.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>Evidence gathered:</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                {run.assessment.evidence.map((ev, i) => (
                  <li key={i} style={{ marginBottom: 3 }}>
                    <code style={{ fontSize: 11, background: 'var(--bg-soft)', padding: '1px 4px', borderRadius: 3, marginRight: 6 }}>
                      {ev.source}
                    </code>
                    {ev.finding}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Risks */}
          {run.assessment.risks && run.assessment.risks.length > 0 && (
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--red)', marginBottom: 4 }}>Identified Risks:</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--red)' }}>
                {run.assessment.risks.map((risk, i) => (
                  <li key={i} style={{ marginBottom: 2 }}>{risk}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Trace Steps by Turn */}
      {turns.length > 0 && (
        <div className="agent-trace" style={{ marginTop: 12 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>
            Execution Trace ({run?.steps.length} steps)
          </h4>
          <div className="trace-turns" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {turns.map(([turnNum, steps]) => (
              <div key={turnNum} className="trace-turn" style={{ background: 'var(--bg-soft)', borderRadius: 6, padding: '8px 10px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 6 }}>
                  Turn {turnNum}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {steps.map((st) => (
                    <StepItem key={st.index} step={st} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StepItem({ step }: { step: AgentStep }) {
  const isErr = step.ok === false;
  return (
    <div
      className={`step-item ${step.type} ${isErr ? 'err' : ''}`}
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        fontSize: 12,
        lineHeight: 1.35,
        padding: '3px 0',
        borderBottom: '1px dashed rgba(0,0,0,0.06)',
      }}
    >
      <span
        style={{
          fontFamily: 'monospace',
          fontSize: 10.5,
          fontWeight: 600,
          padding: '1px 5px',
          borderRadius: 3,
          background: step.type === 'tool_result' ? (isErr ? '#FEE2E2' : '#DCFCE7') : step.type === 'tool_call' ? '#DBEAFE' : '#E2E8F0',
          color: step.type === 'tool_result' ? (isErr ? '#991B1B' : '#166534') : step.type === 'tool_call' ? '#1E40AF' : '#475569',
        }}
      >
        {step.type}
      </span>

      {step.tool && (
        <code style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink)' }}>
          {step.tool}
        </code>
      )}

      <span style={{ flex: 1, color: isErr ? 'var(--red)' : 'var(--ink)' }}>
        {step.summary}
      </span>

      <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 10.5 }}>
        {step.synthetic && (
          <span
            style={{ background: '#FEF3C7', color: '#92400E', padding: '1px 4px', borderRadius: 3, fontWeight: 600 }}
            title="Synthetic demo fixture result"
          >
            synthetic
          </span>
        )}
        {step.cached && (
          <span
            style={{ background: '#E0E7FF', color: '#3730A3', padding: '1px 4px', borderRadius: 3, fontWeight: 600 }}
            title="Cached tool response"
          >
            cached
          </span>
        )}
        {step.ms !== null && step.ms !== undefined && (
          <span style={{ color: 'var(--muted)', fontFamily: 'monospace' }}>
            {step.ms}ms
          </span>
        )}
      </div>
    </div>
  );
}

function ProposalCard({
  proposal,
  sosId,
  isAdmin,
  canAct,
  responders,
}: {
  proposal: AgentProposal;
  sosId: string;
  isAdmin: boolean;
  canAct: boolean;
  responders: Responder[];
}) {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const units = useUi((s) => s.units);

  const [etaOverride, setEtaOverride] = useState<string>(proposal.eta_minutes ? String(proposal.eta_minutes) : '');
  const [note, setNote] = useState('');
  const [sendVictimMessage, setSendVictimMessage] = useState(false);
  const [selectedResponder, setSelectedResponder] = useState<string>(proposal.responder_id ?? '');
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const isProposed = proposal.status === 'proposed';

  const handleApprove = async () => {
    try {
      setBusy(true);
      await api.approveAgentProposal(sosId, proposal.id, {
        eta_minutes: etaOverride ? Number(etaOverride) : undefined,
        note: note.trim() || undefined,
        send_victim_message: sendVictimMessage,
        responder_id: isAdmin && selectedResponder ? selectedResponder : undefined,
      });
      toast('success', 'Proposal approved! Dispatch created.');
      invalidateCase(qc, sosId);
      void qc.invalidateQueries({ queryKey: qk.assignments });
      void qc.invalidateQueries({ queryKey: qk.responders });
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 409) {
        toast('error', 'Proposal already decided or superseded.');
      } else if (e instanceof ApiError && e.status === 403) {
        toast('error', 'Forbidden: only the assigned responder or an admin can approve.');
      } else {
        toast('error', errorMessage(e));
      }
      invalidateCase(qc, sosId);
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    try {
      setBusy(true);
      await api.rejectAgentProposal(sosId, proposal.id, {
        reason: rejectReason.trim() || undefined,
      });
      toast('success', 'Proposal rejected.');
      invalidateCase(qc, sosId);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 409) {
        toast('error', 'Proposal already decided or superseded.');
      } else if (e instanceof ApiError && e.status === 403) {
        toast('error', 'Forbidden: only the assigned responder or an admin can reject.');
      } else {
        toast('error', errorMessage(e));
      }
      invalidateCase(qc, sosId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`card proposal-card ${proposal.status}`}
      style={{
        border: '1.5px solid var(--blue)',
        borderRadius: 8,
        padding: '14px',
        marginBottom: 16,
        background: '#F0F9FF',
      }}
      data-testid="proposal-card"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h4 style={{ margin: 0, fontSize: 14, color: 'var(--blue)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>Proposed Dispatch Plan</span>
        </h4>
        <span
          className={`st ${proposal.status === 'approved' ? 'os' : proposal.status === 'rejected' ? 'sil' : 'enr'}`}
          style={{ textTransform: 'uppercase', fontSize: 10.5 }}
        >
          {proposal.status}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12.5, marginBottom: 10 }}>
        <div>
          <span className="muted" style={{ display: 'block', fontSize: 11 }}>Recommended Unit:</span>
          <strong>{proposal.responder_name ?? 'None named'}</strong>
        </div>
        <div>
          <span className="muted" style={{ display: 'block', fontSize: 11 }}>Estimated Travel Time:</span>
          <strong>{proposal.eta_minutes != null ? `${proposal.eta_minutes} min` : 'Not determined'}</strong>
        </div>
      </div>

      {proposal.equipment && proposal.equipment.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <span className="muted" style={{ display: 'block', fontSize: 11, marginBottom: 3 }}>Recommended Equipment:</span>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {proposal.equipment.map((eq, i) => (
              <span key={i} style={{ background: '#E0F2FE', color: '#0369A1', fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4 }}>
                {eq}
              </span>
            ))}
          </div>
        </div>
      )}

      {proposal.facility && (
        <div style={{ marginBottom: 8, fontSize: 12 }}>
          <span className="muted" style={{ display: 'block', fontSize: 11 }}>Destination Facility:</span>
          <span>
            {proposal.facility.name} ({proposal.facility.kind}) · {formatKm(proposal.facility.distance_km, units)} away
          </span>
        </div>
      )}

      {proposal.victim_message && (
        <div style={{ marginBottom: 10, background: '#fff', padding: '8px 10px', borderRadius: 6, border: '1px solid #BAE6FD', fontSize: 12 }}>
          <span style={{ fontWeight: 600, color: 'var(--blue)', display: 'block', marginBottom: 2 }}>Proposed Message to Victim:</span>
          "{proposal.victim_message}"
        </div>
      )}

      {proposal.notes && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10, fontStyle: 'italic' }}>
          Note: {proposal.notes}
        </div>
      )}

      {/* Decision info if already decided */}
      {!isProposed && (
        <div style={{ fontSize: 12, marginTop: 8, color: 'var(--muted)' }}>
          {proposal.status === 'approved' && `Approved ${proposal.decided_at ? formatDateTime(proposal.decided_at) : ''}`}
          {proposal.status === 'rejected' && `Rejected ${proposal.decided_at ? formatDateTime(proposal.decided_at) : ''}${proposal.decision_note ? `: ${proposal.decision_note}` : ''}`}
        </div>
      )}

      {/* Action controls when proposed */}
      {isProposed && canAct && (
        <div style={{ marginTop: 12, borderTop: '1px solid #BAE6FD', paddingTop: 10 }}>
          {!showRejectForm ? (
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <label htmlFor="prop-eta" style={{ fontSize: 11.5, fontWeight: 600 }}>ETA (min):</label>
                  <input
                    id="prop-eta"
                    type="number"
                    min={1}
                    max={1440}
                    value={etaOverride}
                    onChange={(e) => setEtaOverride(e.target.value)}
                    style={{ width: 65, padding: '3px 6px', fontSize: 12 }}
                  />
                </div>

                {isAdmin && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                    <label htmlFor="prop-resp" style={{ fontSize: 11.5, fontWeight: 600 }}>Assign:</label>
                    <select
                      id="prop-resp"
                      value={selectedResponder}
                      onChange={(e) => setSelectedResponder(e.target.value)}
                      style={{ padding: '3px 6px', fontSize: 12, flex: 1 }}
                    >
                      <option value="">Default ({proposal.responder_name ?? 'None'})</option>
                      {responders.map((r) => (
                        <option key={r.id} value={r.id}>{r.name} ({r.role})</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 8 }}>
                <input
                  type="text"
                  placeholder="Optional case note..."
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  style={{ width: '100%', padding: '4px 8px', fontSize: 12 }}
                />
              </div>

              {proposal.victim_message && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 10, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={sendVictimMessage}
                    onChange={(e) => setSendVictimMessage(e.target.checked)}
                  />
                  <span>Send proposed message to victim as status update</span>
                </label>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={handleApprove}
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  {busy ? 'Approving…' : 'Approve & Dispatch Unit'}
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => setShowRejectForm(true)}
                >
                  Reject…
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 8 }}>
                <label htmlFor="rej-reason" style={{ fontSize: 11.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                  Reason for rejection (optional):
                </label>
                <input
                  id="rej-reason"
                  type="text"
                  placeholder="e.g. Unit deployed elsewhere, invalid assessment"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  maxLength={500}
                  style={{ width: '100%', padding: '4px 8px', fontSize: 12 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={handleReject}
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  {busy ? 'Rejecting…' : 'Confirm Rejection'}
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => setShowRejectForm(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
