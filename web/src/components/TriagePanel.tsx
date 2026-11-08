import type { Sos, SosDetail } from '../api/models';
import { REASON_SOURCE_LABEL, describeScoreChange, groupReasons, triageInfo } from '../lib/triage';
import { formatAge, formatDateTime } from '../lib/time';
import { useUi } from '../state/ui';
import { AiChip } from './chips';

const SOURCE_COLOR: Record<string, string> = {
  rule: 'var(--red)',
  llm: 'var(--orange)',
  silence: 'var(--purple)',
  heartbeat: 'var(--purple)',
  checkin: 'var(--red)',
  manual: 'var(--blue)',
};

type CaseLike = Sos & Partial<SosDetail>;

/** AI triage block: status, attempts, model, last AI pass, and the score change note for ~10 s after the AI answered. */
export function AiStatus({ c, now }: { c: CaseLike; now?: number }) {
  const t = c.triage;
  const status = t?.triage_status ?? c.triage_status;
  const info = triageInfo(status);
  const change = useUi((s) => s.triageChanges[c.id]);
  const updated = t?.triage_updated_at ?? c.triage_updated_at;
  const attempts = t?.triage_attempts ?? c.triage_attempts;
  const headline =
    info.state === 'pending' ? 'Provisional score from rules. The AI is still analysing this report.' :
    info.state === 'failed' ? 'AI unavailable, rules only. The server retries automatically.' :
    info.state === 'done' ? 'The AI read of the message has been applied.' : 'No AI status reported by this server.';
  return (
    <div className="ai-status" data-testid="ai-status" data-state={info.state}>
      <div className="ai-status-h">
        {info.state === 'done' ? <span className="aichip done"><i aria-hidden="true" />AI scored</span> : info.state === 'unknown' ? null : <AiChip status={status} />}
        <span className="note">{headline}</span>
      </div>
      {change && <p className="ai-note" role="status" data-testid="ai-change">{describeScoreChange(change)}</p>}
      <dl className="kv2">
        <div><dt>Status</dt><dd>{status ?? '-'}</dd></div>
        <div><dt>Attempts</dt><dd>{attempts ?? 0}</dd></div>
        <div><dt>Model</dt><dd>{t?.model ?? (t?.llm_used === false ? 'none (rules only)' : '-')}</dd></div>
        <div><dt>Last AI pass</dt><dd>{updated ? `${formatDateTime(updated)} (${formatAge(updated, now)})` : 'not yet'}</dd></div>
      </dl>
    </div>
  );
}

/** Reasons split into rule reasons and AI reasons (and contact signals), each line labelled with its source. */
export function ReasonGroups({ c }: { c: CaseLike }) {
  const reasons = c.triage?.reasons ?? c.reasons ?? [];
  if (!reasons.length) return <p className="note">No reasons recorded.</p>;
  return (
    <>
      {groupReasons(reasons).map((g) => (
        <div key={g.key} className="rgroup" data-testid={`reasons-${g.key}`}>
          <h4>{g.label}</h4>
          {g.items.map((r, i) => (
            <div key={i}>
              <div className="sb">
                <span><em className={`src ${r.source}`}>{REASON_SOURCE_LABEL[r.source]}</em> {r.text}</span>
                {r.weight !== undefined && <b>{r.weight > 0 && r.source !== 'rule' ? `+${r.weight}` : r.weight}</b>}
              </div>
              {r.weight !== undefined && (
                <div className="sbar">
                  <i style={{ width: `${Math.min(100, Math.max(2, Math.abs(r.weight)))}%`, background: SOURCE_COLOR[r.source] }} />
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
