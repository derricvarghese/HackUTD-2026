import { QueryClient } from '@tanstack/react-query';
import type { WsFrame } from '../api/models';
import { makeSilent, makeSos } from '../test/fixtures';
import { qk } from './data';
import { applyFrame } from './live';

const frame = (event: WsFrame['event'], data: unknown): WsFrame => ({ event, data, ts: '2026-11-07T10:00:00Z' }) as WsFrame;

describe('applyFrame', () => {
  it('patches the open-case cache and keeps it ranked', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.open, [makeSos({ id: 'a-1', score: 50 })]);
    applyFrame(qc, frame('sos.created', makeSos({ id: 'b-2', score: 95 })));
    expect(qc.getQueryData<{ id: string }[]>(qk.open)?.map((c) => c.id)).toEqual(['b-2', 'a-1']);
    applyFrame(qc, frame('sos.updated', makeSos({ id: 'b-2', score: 95, status: 'resolved' })));
    expect(qc.getQueryData<{ id: string }[]>(qk.open)?.map((c) => c.id)).toEqual(['a-1']);
    applyFrame(qc, frame('sos.merged', { primary_id: 'x', merged_ids: ['a-1'] }));
    expect(qc.getQueryData(qk.open)).toEqual([]);
  });
  it('tracks silent devices, dead zones and mesh stats', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.silent, []);
    applyFrame(qc, frame('heartbeat.silent', makeSilent({ device_id: 'd1' })));
    expect(qc.getQueryData<unknown[]>(qk.silent)).toHaveLength(1);
    applyFrame(qc, frame('heartbeat.resumed', makeSilent({ device_id: 'd1' })));
    expect(qc.getQueryData<unknown[]>(qk.silent)).toHaveLength(0);
    applyFrame(qc, frame('deadzones.updated', { data: [{ id: 'z' }] }));
    expect(qc.getQueryData(qk.deadzones)).toEqual([{ id: 'z' }]);
    applyFrame(qc, frame('mesh.stats', { avg_hops: 3 }));
    expect(qc.getQueryData(qk.mesh)).toEqual({ avg_hops: 3 });
  });
  it('profile.updated refreshes the affected cases without touching sensitive data', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.detail('s1'), { id: 's1' });
    qc.setQueryData(qk.open, [makeSos({ id: 's1' })]);
    applyFrame(qc, frame('profile.updated', { device_id: 'd', sos_ids: ['s1'], view: 'public', full_name: 'A B', vulnerability_flags: [], has_profile: true }));
    expect(qc.getQueryState(qk.detail('s1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.open)?.isInvalidated).toBe(true);
  });
  it('does nothing to caches that were never loaded', () => {
    const qc = new QueryClient();
    applyFrame(qc, frame('sos.created', makeSos()));
    expect(qc.getQueryData(qk.open)).toBeUndefined();
  });
});
