import type { KeyboardEvent } from 'react';
import type { Sos, SilentDevice } from '../api/models';
import { channelLabel } from '../lib/hops';
import { resolveLocation, shortLocation } from '../lib/privacy';
import { useReverseGeocode } from '../hooks/useReverseGeocode';
import { CATEGORY_LABEL, TIER_LABEL, TIER_TEXT, TIER_VAR, caseKind, caseTitle, deviceShortId, shortId, whyText } from '../lib/tier';
import { formatAge, formatDuration, silentForMinutes } from '../lib/time';
import { useCanAct } from '../state/auth';
import { useUi } from '../state/ui';
import { nameLine } from '../lib/profile';
import { PersonLine } from './Person';
import { StatusTrail } from './ui';

/** Sum of score added by silence/heartbeat detectors, shown as the "+20" under a silent badge. */
export function silenceBoost(c: Sos): number {
  return (c.reasons ?? []).filter((r) => r.source === 'silence' || r.source === 'heartbeat').reduce((n, r) => n + (r.weight ?? 0), 0);
}

const CARD_CLASS = { critical: 'c', high: 'h', silent: 's', normal: 'nr', safe: 'sf' } as const;

function keyActivate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  };
}

export function ClaimButton({ c }: { c: Sos }) {
  const canAct = useCanAct();
  const a = c.assignment;
  if (a && ['assigned', 'en_route', 'on_scene'].includes(a.status)) {
    return (
      <span className="claim done" style={{ cursor: 'default' }} title={`Assigned to ${a.responder_name ?? 'a responder'}`}>
        {a.responder_name ?? 'Assigned'}
      </span>
    );
  }
  if (!canAct || c.status === 'resolved') return null;
  return (
    <button
      className="claim"
      onClick={(e) => {
        e.stopPropagation();
        useUi.getState().setOpenCaseId(c.id);
      }}
      aria-label={`Claim ${c.profile?.full_name ? `${c.profile.full_name}, ` : ''}${shortId(c.id)}`}
    >
      Assign
    </button>
  );
}

export function CaseCard({ c, selected, onSelect, now, onOpen }: { c: Sos; selected: boolean; onSelect: () => void; now: number; onOpen?: () => void }) {
  const kind = caseKind(c);
  const boost = silenceBoost(c);
  const sm = silentForMinutes(c, now);
  const why = whyText(c);
  const people = c.people_count ? `${c.people_count} ${c.people_count === 1 ? 'person' : 'people'}` : null;
  const loc = resolveLocation(c);
  const address = useReverseGeocode(loc.lat, loc.lng);
  return (
    <div
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-label={`${nameLine(c.profile)}, ${shortId(c.id)}, ${CATEGORY_LABEL[c.category]}, score ${c.score}${c.silent ? ', went silent' : ''}`}
      className={`case ${CARD_CLASS[kind]}${selected ? ' sel' : ''}`}
      onClick={onSelect}
      onKeyDown={keyActivate(onSelect)}
      data-testid="case-card"
    >
      <div className="badge" style={{ background: TIER_VAR[kind], color: TIER_TEXT[kind] }}>
        <div>
          {c.score}
          <small>{c.silent && boost > 0 ? `▲ +${boost}` : 'SCORE'}</small>
        </div>
      </div>
      <div className="cbody">
        <div className="ctop">
          <PersonLine profile={c.profile} />
          <span className="tagx" style={{ background: kind === 'silent' ? 'var(--red)' : TIER_VAR[kind], color: kind === 'silent' ? '#fff' : TIER_TEXT[kind] }}>
            {TIER_LABEL[kind]}
          </span>
        </div>
        <div className="csub" title={c.text ?? undefined}>
          {shortId(c.id)} · {caseTitle(c)}
        </div>
        <div className="meta">
          <span>{address ? `${address} · ` : ''}{shortLocation(c)}</span>
          {people && <span>{people}</span>}
          {c.silent && sm !== null && <span className="redt">{sm < 1 ? 'Silent just now' : `Silent ${formatDuration(sm * 60)}`}</span>}
          {!!c.duplicate_count && <span>{c.duplicate_count} merged</span>}
        </div>
        <div className="why">
          {why} {c.confidence && <em>Confidence: {c.confidence}</em>}
        </div>
        {c.assignment && c.status !== 'reported' && <StatusTrail status={c.status} eta={c.assignment.eta_minutes} />}
        <div className="cfoot">
          <span className="chan">{channelLabel(c.channel, c.hop)}</span>
          {c.has_voice_note && <span className="chan">Voice note</span>}
          <span className="ago">{c.silent ? `last heard ${formatAge(c.last_heard_at, now)}` : formatAge(c.received_at ?? c.created_at, now)}</span>
          {selected && onOpen && (
            <button className="claim ghost" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
              Details
            </button>
          )}
          <ClaimButton c={c} />
        </div>
      </div>
    </div>
  );
}

/** A silent device that never pressed SOS: shown in the queue as "possible distress" with a promote action. */
export function DeviceCard({ d, now, onPromote, busy, canAct }: { d: SilentDevice; now: number; onPromote: () => void; busy: boolean; canAct: boolean }) {
  const mins = Math.round((d.silent_for_seconds ?? 0) / 60);
  return (
    <div className="case n" data-testid="device-card">
      <div className="badge" style={{ background: 'var(--purple)' }}>
        <div>
          {d.priority_score ?? '?'}
          <small>HB</small>
        </div>
      </div>
      <div className="cbody">
        <div className="ctop">
          <b>Device {deviceShortId(d.device_id).slice(4)} · Heartbeat stopped</b>
          <span className="tagx" style={{ background: 'var(--purple)' }}>
            {d.status === 'distress' ? 'POSSIBLE DISTRESS' : 'QUIET'}
          </span>
        </div>
        <div className="meta">
          <span>
            ~{Math.round(d.last_approx.radius_m / 100) / 10} km area · {d.last_approx.lat.toFixed(2)}, {d.last_approx.lng.toFixed(2)}
          </span>
          {typeof d.last_battery_pct === 'number' && <span>{d.last_battery_pct}% at last beat</span>}
        </div>
        <div className="why">{d.reason ?? `Went quiet ${mins} min ago${d.neighbors_active ? ` while ${d.neighbors_active} neighbours kept reporting` : ''}. Silence is the signal.`}</div>
        <div className="cfoot">
          <span className="chan">Mesh heartbeat</span>
          <span className="ago">{formatAge(d.last_heartbeat_at, now)}</span>
          {canAct && (
            <button className="claim" disabled={busy} onClick={onPromote} aria-label={`Promote device ${deviceShortId(d.device_id)} to a case`}>
              {busy ? 'Promoting…' : 'Make case'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
