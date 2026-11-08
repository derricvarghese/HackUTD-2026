import { Link } from 'react-router-dom';
import * as api from '../api/endpoints';
import type { Sos, SilentDevice } from '../api/models';
import { CaseCard, DeviceCard } from './CaseCard';
import { Empty, Skeletons } from './ui';
import { qk, useAction, useSilent } from '../hooks/data';
import { matchesTab, type QueueTab } from '../lib/query';
import { useCanAct } from '../state/auth';
import { useUi } from '../state/ui';

export type QueueItem = { kind: 'case'; score: number; c: Sos } | { kind: 'device'; score: number; d: SilentDevice };

/** Silent devices that are worth a dispatcher's attention: in distress, not acknowledged and without an SOS of their own. */
export const queueDevices = (devs: SilentDevice[] | undefined) => (devs ?? []).filter((d) => d.status === 'distress' && !d.acknowledged && !d.open_sos_id);

export function mergeQueue(cases: Sos[], devices: SilentDevice[], tab: QueueTab): QueueItem[] {
  const items: QueueItem[] = cases.filter((c) => matchesTab(c, tab)).map((c) => ({ kind: 'case', score: c.score, c }));
  if (tab === 'all' || tab === 'silent') for (const d of devices) items.push({ kind: 'device', score: d.priority_score ?? 0, d });
  // stable: cases keep API order; devices slot in by score
  return items.sort((a, b) => b.score - a.score);
}

export function QueueList({ items, selectedId, onSelect, onOpen, now, loading, emptyText }: {
  items: QueueItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
  now: number;
  loading?: boolean;
  emptyText?: string;
}) {
  const canAct = useCanAct();
  const toast = useUi((s) => s.toast);
  const promote = useAction((d: SilentDevice) => api.promoteSilent(d.device_id), {
    success: 'Promoted to a case',
    invalidate: (qc) => {
      void qc.invalidateQueries({ queryKey: qk.silent });
      void qc.invalidateQueries({ queryKey: ['cases'] });
    },
  });
  void toast;
  if (loading) return <Skeletons n={4} />;
  if (!items.length) return <Empty>{emptyText ?? 'Nothing in the queue. New SOS cases appear here the moment a phone reaches a gateway.'}</Empty>;
  return (
    <div className="q" role="list" aria-label="Triage queue">
      {items.map((it) =>
        it.kind === 'case' ? (
          <div role="listitem" key={it.c.id} style={{ display: 'contents' }}>
            <CaseCard c={it.c} selected={it.c.id === selectedId} onSelect={() => onSelect(it.c.id)} now={now} onOpen={onOpen ? () => onOpen(it.c.id) : undefined} />
          </div>
        ) : (
          <div role="listitem" key={it.d.device_id} style={{ display: 'contents' }}>
            <DeviceCard d={it.d} now={now} canAct={canAct} busy={promote.isPending && promote.variables?.device_id === it.d.device_id} onPromote={() => promote.mutate(it.d)} />
          </div>
        ),
      )}
    </div>
  );
}

export function useQueueSources() {
  return { silent: useSilent() };
}

export function ViewAll() {
  return (
    <Link className="more" to="/queue">
      View all →
    </Link>
  );
}
