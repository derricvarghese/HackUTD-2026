import type { Checkin } from '../api/models';
import { useNow } from '../hooks/useNow';
import { choiceLabel, formatCountdown, overdueText, splitCheckins, welfareState, welfareSummary } from '../lib/contact';
import { formatClock } from '../lib/time';

/** Live countdown to a deadline ("4:20 left" / "overdue 1:05"); ticks once a second. */
export function Countdown({ iso }: { iso: string | null | undefined }) {
  const now = useNow(1000);
  const cd = formatCountdown(iso, now);
  if (!cd) return <>-</>;
  return <span className={cd.overdue ? 'redt' : ''}>{cd.text}</span>;
}

export const STATE_LABEL = { answered: 'Answered', answered_late: 'Answered late', missed: 'Overdue', waiting: 'Pending' } as const;

export function StateTag({ k, now }: { k: Checkin; now: number }) {
  const st = welfareState(k, now);
  const cls = st === 'missed' ? 'red' : st === 'waiting' ? 'amber' : 'green';
  return <span className={`cchip ${cls}`}><i aria-hidden="true" />{STATE_LABEL[st]}</span>;
}

export const choicesText = (k: Pick<Checkin, 'choices'>): string => (k.choices?.length ? k.choices.map(choiceLabel).join(' / ') : 'No choices recorded');

/** One card for the case's active check-in (pending -> overdue -> answered), then compact history of answered ones. */
export function WelfareList({ checkins }: { checkins: Checkin[] }) {
  const now = useNow(1000);
  const { active, history } = splitCheckins(checkins);
  return (
    <div className="welfare-wrap">
      {active && <ActiveCheckin k={active} now={now} />}
      {history.length > 0 && (
        <ul className="welfare-hist" aria-label="Answered check-ins">
          {history.map((k) => (
            <li key={k.id}>
              <time>{formatClock(k.responded_at)}</time>
              <span className={k.response === 'need_urgent_help' || k.response === 'need_help' ? 'redt' : ''}>Attempt {k.attempt ?? 1}: {choiceLabel(k.response)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActiveCheckin({ k, now }: { k: Checkin; now: number }) {
  const st = welfareState(k, now);
  const od = st === 'missed' ? overdueText(k, now) : null;
  return (
    <div className={`welfare ${st}`}>
      <div className="welfare-h">
        <b>Attempt {k.attempt ?? 1}</b>
        <StateTag k={k} now={now} />
      </div>
      <dl>
        <div><dt>Offered</dt><dd>{choicesText(k)}</dd></div>
        <div><dt>Sent</dt><dd>{formatClock(k.sent_at)}{k.message ? `, note: "${k.message}"` : ''}</dd></div>
        {od ? (
          <div><dt>Status</dt><dd className="redt">{od.since}{od.reminders ? `, ${od.reminders}` : ''}</dd></div>
        ) : (
          k.deadline_at && <div><dt>Deadline</dt><dd>{formatClock(k.deadline_at)} · <Countdown iso={k.deadline_at} /></dd></div>
        )}
      </dl>
      <span className="sr-only">{welfareSummary(k, now)}</span>
    </div>
  );
}
