import type { WsFrame } from '../api/models';
import { makeSilent, makeSos } from '../test/fixtures';
import { type FeedItem, comparePriority, deriveFeed, describeFrame, mergeUpdated, pushFeed, removeCases, removeSilent, sortByPriority, upsertById, upsertCase, upsertSilent } from './live';

const A = makeSos({ id: 'a-0001', score: 50, created_at: '2026-11-07T10:00:00Z' });
const B = makeSos({ id: 'b-0002', score: 90, created_at: '2026-11-07T10:05:00Z' });
const C = makeSos({ id: 'c-0003', score: 90, silent: true, created_at: '2026-11-07T10:10:00Z' });

describe('priority order', () => {
  it('sorts by score, silent first, then oldest', () => {
    expect(sortByPriority([A, B, C]).map((x) => x.id)).toEqual(['c-0003', 'b-0002', 'a-0001']);
    const older = makeSos({ id: 'd', score: 90, created_at: '2026-11-07T09:00:00Z' });
    expect(comparePriority(older, B)).toBeLessThan(0);
  });
});

describe('ws reducers', () => {
  it('upserts open cases in priority order', () => {
    const l = upsertCase([A], B);
    expect(l.map((x) => x.id)).toEqual(['b-0002', 'a-0001']);
    expect(upsertCase(l, { ...A, score: 99 }).map((x) => x.id)).toEqual(['a-0001', 'b-0002']);
  });
  it('drops cases that left the open set', () => {
    expect(upsertCase([A, B], { ...A, status: 'resolved' }).map((x) => x.id)).toEqual(['b-0002']);
    const same = [A];
    expect(upsertCase(same, { ...B, status: 'merged' })).toBe(same);
  });
  it('removes merged ids and keeps identity when nothing changes', () => {
    expect(removeCases([A, B], ['a-0001']).map((x) => x.id)).toEqual(['b-0002']);
    const l = [A];
    expect(removeCases(l, ['zzz'])).toBe(l);
  });
  it('merges a catch-up batch', () => {
    const out = mergeUpdated([A], [{ ...A, score: 70 }, B, { ...C, status: 'closed' }]);
    expect(out.map((x) => [x.id, x.score])).toEqual([['b-0002', 90], ['a-0001', 70]]);
  });
  it('upserts generic items and silent devices', () => {
    expect(upsertById([{ id: '1', v: 1 }], { id: '1', v: 2 })).toEqual([{ id: '1', v: 2 }]);
    expect(upsertById([{ id: '1', v: 1 }], { id: '2', v: 2 }).map((x) => x.id)).toEqual(['2', '1']);
    const d1 = makeSilent({ device_id: 'd1', priority_score: 50 });
    const d2 = makeSilent({ device_id: 'd2', priority_score: 80 });
    expect(upsertSilent([d1], d2).map((d) => d.device_id)).toEqual(['d2', 'd1']);
    expect(upsertSilent([d1, d2], { ...d1, acknowledged: true }).map((d) => d.device_id)).toEqual(['d2']);
    expect(removeSilent([d1, d2], 'd1').map((d) => d.device_id)).toEqual(['d2']);
  });
});

const frame = (event: WsFrame['event'], data: unknown): WsFrame => ({ event, data, ts: '2026-11-07T10:00:00Z' }) as WsFrame;

describe('feed sentences', () => {
  it('describes new cases, claims and merges', () => {
    expect(describeFrame(frame('sos.created', B))?.text).toBe('SOS-0002 received via 3 hops, score 90');
    expect(describeFrame(frame('sos.created', B))?.tone).toBe('alert');
    expect(describeFrame(frame('sos.merged', { primary_id: B.id, merged_ids: ['x', 'y'] }))?.text).toBe('2 reports merged into SOS-0002');
    const a = describeFrame(frame('assignment.created', { id: 'a', sos_id: B.id, responder_id: 'r', responder_name: 'Alice', status: 'assigned', created_at: 'x' }));
    expect(a?.text).toBe('Alice claimed SOS-0002');
    expect(a?.tone).toBe('ok');
    const e = describeFrame(frame('assignment.updated', { id: 'a', sos_id: B.id, responder_id: 'r', responder_name: 'Alice', status: 'en_route', eta_minutes: 6, created_at: 'x' }));
    expect(e?.text).toBe('Alice is en route (ETA 6 min) on SOS-0002');
  });
  it('describes silence and heartbeats', () => {
    expect(describeFrame(frame('sos.silent', C))?.tone).toBe('alert');
    expect(describeFrame(frame('heartbeat.silent', makeSilent()))?.text).toBe('DEV-7F2C lost contact (possible distress)');
    expect(describeFrame(frame('heartbeat.resumed', makeSilent()))?.tone).toBe('ok');
  });
  it('ignores frames without a story', () => {
    expect(describeFrame(frame('mesh.stats', {}))).toBeNull();
    expect(describeFrame(frame('pong', null))).toBeNull();
    expect(describeFrame(frame('deadzones.updated', undefined))).toBeNull();
  });
  it('caps the feed and derives initial items from cases', () => {
    const items: FeedItem[] = Array.from({ length: 50 }, (_, i) => ({ id: String(i), ts: 't', tone: 'info', text: 'x' }));
    expect(items.reduce((f, i) => pushFeed(f, i), [] as FeedItem[])).toHaveLength(40);
    const d = deriveFeed([A, { ...C, silent_since: '2026-11-07T10:20:00Z' }]);
    expect(d[0].text).toContain('went silent');
    expect(d.length).toBeGreaterThanOrEqual(3);
  });
});
