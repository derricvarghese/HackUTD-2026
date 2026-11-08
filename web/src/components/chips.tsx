// Small status chips shared by queue cards, the queue table and the case panel.
import type { Sos } from '../api/models';
import { contactChip } from '../lib/contact';
import { triageInfo } from '../lib/triage';
import { IcCamera } from './icons';

/** Camera chip with the photo count (everyone sees the count; only entitled viewers see the photos). */
export function CameraChip({ count }: { count?: number | null }) {
  if (!count) return null;
  const label = `${count} ${count === 1 ? 'photo' : 'photos'}`;
  return (
    <span className="chan cam" title={label} data-testid="camera-chip">
      <IcCamera width={13} height={13} />
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Contact state chip: green connected, amber lost contact, red unresponsive. The tooltip carries the detail. */
export function ContactChip({ c, now }: { c: Pick<Sos, 'contact_state' | 'last_heartbeat_at' | 'welfare_missed'>; now?: number }) {
  const chip = contactChip(c, now);
  if (!chip) return null;
  return (
    <span className={`cchip ${chip.tone}`} title={chip.tooltip} data-testid="contact-chip" data-state={chip.state}>
      <i aria-hidden="true" />
      <span aria-hidden="true">{chip.label}</span>
      <span className="sr-only">{chip.tooltip}</span>
    </span>
  );
}

/** Text chip for the AI state: only for pending/failed (nothing is shown once the AI result is applied). */
export function AiChip({ status }: { status: Sos['triage_status'] | undefined }) {
  const info = triageInfo(status);
  if (info.state !== 'pending' && info.state !== 'failed') return null;
  return (
    <span className={`aichip ${info.state}`} title={info.tooltip} data-testid="ai-chip">
      <i aria-hidden="true" />
      <span aria-hidden="true">{info.label}</span>
      <span className="sr-only">{`: ${info.tooltip}`}</span>
    </span>
  );
}
