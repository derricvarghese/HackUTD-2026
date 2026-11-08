import { QueryClient } from '@tanstack/react-query';
import type { WsFrame } from '../api/models';
import { makeSilent, makeSos } from '../test/fixtures';
import { useUi } from '../state/ui';
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
  it('ignores stale frames by version and keeps the newer case', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.open, [makeSos({ id: 'a', score: 75, version: 4, triage_status: 'complete' })]);
    applyFrame(qc, frame('sos.updated', makeSos({ id: 'a', score: 65, version: 3, triage_status: 'provisional' })));
    expect(qc.getQueryData<{ score: number }[]>(qk.open)?.[0].score).toBe(75);
  });
  it('records the AI score change when provisional turns complete, and re-sorts without touching the selection', () => {
    const qc = new QueryClient();
    useUi.setState({ selectedId: 'b', triageChanges: {} });
    qc.setQueryData(qk.open, [makeSos({ id: 'a', score: 80, version: 1 }), makeSos({ id: 'b', score: 65, version: 1, triage_status: 'provisional' })]);
    applyFrame(qc, frame('sos.updated', makeSos({ id: 'b', score: 90, version: 2, triage_status: 'complete' })));
    expect(qc.getQueryData<{ id: string }[]>(qk.open)?.map((c) => c.id)).toEqual(['b', 'a']);
    expect(useUi.getState().selectedId).toBe('b');
    expect(useUi.getState().triageChanges.b).toMatchObject({ from: 65, to: 90, delta: 25 });
  });
  it('a new case arrives provisional and is ranked at once', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.open, [makeSos({ id: 'a', score: 50 })]);
    applyFrame(qc, frame('sos.created', makeSos({ id: 'n', score: 70, triage_status: 'provisional' })));
    expect(qc.getQueryData<{ id: string; triage_status: string }[]>(qk.open)?.[0]).toMatchObject({ id: 'n', triage_status: 'provisional' });
  });
  it('heartbeat.silent keeps the connectivity of the payload (lost_contact by default)', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.silent, []);
    applyFrame(qc, frame('heartbeat.silent', makeSilent({ device_id: 'd2' })));
    expect(qc.getQueryData<{ connectivity: string }[]>(qk.silent)?.[0].connectivity).toBe('lost_contact');
  });
});
