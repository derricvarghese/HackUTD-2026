import { overdueText, splitCheckins, choiceLabel, contactChip, eventLabel, formatCountdown, askedUrgentHelp, isSelfResolved, lastHeardText, welfareState, welfareSummary, heartbeatAgo } from './contact';

const NOW = Date.parse('2026-11-07T10:30:00Z');

describe('contact chip', () => {
  it('connected is green', () => {
    expect(contactChip({ contact_state: 'connected' })).toMatchObject({ tone: 'green', label: 'Connected' });
  });
  it('lost contact is amber and says probably no connectivity with the last heartbeat', () => {
    const c = contactChip({ contact_state: 'lost_contact', last_heartbeat_at: '2026-11-07T10:18:00Z' }, NOW)!;
    expect(c.tone).toBe('amber');
    expect(c.tooltip).toBe('Lost contact: probably no connectivity (last heartbeat 12 min ago)');
  });
  it('unresponsive is red and explains the stronger signal', () => {
    const c = contactChip({ contact_state: 'unresponsive', welfare_missed: 2 }, NOW)!;
    expect(c.tone).toBe('red');
    expect(c.tooltip).toBe('Unresponsive: connected but not answering welfare check-ins (2 missed)');
  });
  it('is absent when the server sent no state', () => {
    expect(contactChip({})).toBeNull();
  });
  it('wording helpers', () => {
    expect(heartbeatAgo(null)).toBe('no heartbeat received yet');
    expect(lastHeardText({ last_heard_at: '2026-11-07T10:25:00Z' }, NOW)).toBe('Last heard 5 min ago');
  });
});

describe('welfare countdown', () => {
  it('formats m:ss below an hour', () => {
    expect(formatCountdown('2026-11-07T10:34:20Z', NOW)).toEqual({ text: '4:20 left', overdue: false, seconds: 260 });
    expect(formatCountdown('2026-11-07T10:30:05Z', NOW)?.text).toBe('0:05 left');
  });
  it('flags overdue deadlines', () => {
    const c = formatCountdown('2026-11-07T10:28:55Z', NOW)!;
    expect(c.overdue).toBe(true);
    expect(c.text).toBe('overdue 1:05');
  });
  it('switches to hours and tolerates bad input', () => {
    expect(formatCountdown('2026-11-07T11:35:00Z', NOW)?.text).toBe('1 h 05 min left');
    expect(formatCountdown(null, NOW)).toBeNull();
    expect(formatCountdown('nope', NOW)).toBeNull();
  });
});

describe('welfare state', () => {
  const base = { sent_at: '2026-11-07T10:20:00Z', deadline_at: '2026-11-07T10:35:00Z' };
  it('walks waiting -> missed -> answered', () => {
    expect(welfareState(base, NOW)).toBe('waiting');
    expect(welfareState(base, Date.parse('2026-11-07T10:36:00Z'))).toBe('missed');
    expect(welfareState({ ...base, missed: true }, NOW)).toBe('missed');
    expect(welfareState({ ...base, responded_at: '2026-11-07T10:25:00Z' }, NOW)).toBe('answered');
    expect(welfareState({ ...base, responded_at: '2026-11-07T10:40:00Z', missed: true }, NOW)).toBe('answered_late');
  });
  it('summarises answers with plain wording, legacy values included', () => {
    expect(choiceLabel('no_longer_need_help')).toBe('I no longer need help');
    expect(choiceLabel('ok')).toBe("I'm still here");
    expect(choiceLabel('need_help')).toBe('I need help urgently');
    expect(welfareSummary({ id: 'x', sos_id: 'y', channel: 'app', sent_at: base.sent_at, responded_at: '2026-11-07T10:25:00Z', response: 'still_here' }, NOW)).toBe("Answered: I'm still here");
  });
});

describe('timeline wording', () => {
  it('uses clear sentences for the new event types', () => {
    expect(eventLabel({ type: 'self_resolved' }).text).toBe('Marked resolved by the person: "I no longer need help"');
    expect(eventLabel({ type: 'urgent_help_requested' })).toEqual({ text: 'Asked for urgent help', tone: 'red' });
    expect(eventLabel({ type: 'contact_restored' }).tone).toBe('green');
    expect(eventLabel({ type: 'checkin_missed' }).tone).toBe('red');
    expect(eventLabel({ type: 'heartbeat_silent' }).text).toMatch(/probably no connectivity/);
    expect(eventLabel({ type: 'checkin_responded', data: { response: 'still_here' } }).text).toBe("Welfare check-in answered: I'm still here");
    expect(eventLabel({ type: 'en_route' }).text).toBe('en route');
  });
  it('detects self-resolved cases and urgent requests', () => {
    expect(isSelfResolved({ status: 'resolved', events: [{ type: 'self_resolved' }] })).toBe(true);
    expect(isSelfResolved({ status: 'reported', events: [{ type: 'self_resolved' }] })).toBe(false);
    expect(askedUrgentHelp({ events: [{ type: 'urgent_help_requested' }] })).toBe(true);
    expect(askedUrgentHelp({ checkins: [{ response: 'need_help' }] })).toBe(true);
    expect(askedUrgentHelp({ checkins: [{ response: 'still_here' }] })).toBe(false);
  });
});

describe('one active check-in per case', () => {
  const k = (id: string, sent: string, over: object = {}) => ({ id, sos_id: 's', channel: 'app' as const, sent_at: sent, ...over });
  it('keeps one active (newest unanswered) and answered ones as history, newest first', () => {
    const r = splitCheckins([
      k('a', '2026-11-07T10:00:00Z', { responded_at: '2026-11-07T10:02:00Z' }),
      k('b', '2026-11-07T10:10:00Z', { missed: true }),
      k('c', '2026-11-07T10:20:00Z', { responded_at: '2026-11-07T10:21:00Z' }),
    ]);
    expect(r.active?.id).toBe('b');
    expect(r.history.map((x) => x.id)).toEqual(['c', 'a']);
    expect(splitCheckins([]).active).toBeNull();
  });
  it('tolerates missing reminder fields and describes them when present', () => {
    const base = k('x', '2026-11-07T10:00:00Z', { deadline_at: '2026-11-07T10:05:00Z' });
    expect(overdueText(base, NOW).reminders).toBeNull();
    const o = overdueText({ ...base, reminder_count: 2, last_reminded_at: '2026-11-07T10:27:00Z' } as typeof base, NOW);
    expect(o.since).toMatch(/^Overdue since/);
    expect(o.reminders).toBe('reminded 2 times, last reminder 3 min ago');
  });
  it('an overdue flag alone marks the check-in overdue', () => {
    expect(welfareState({ overdue: true, deadline_at: '2099-01-01T00:00:00Z' }, NOW)).toBe('missed');
  });
});
