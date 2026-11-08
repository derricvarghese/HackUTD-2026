import * as api from '../api/endpoints';
import type { Deadzone } from '../api/models';
import { qk, useAction } from '../hooks/data';

/** Dead zone status changes shared by the map popup and the dead zone list. */
export function useMapActions() {
  const mut = useAction((v: { d: Deadzone; status: Deadzone['status'] }) => api.patchDeadzone(v.d.id, v.status), {
    success: (d) => (d.status === 'dismissed' ? 'Dead zone dismissed' : d.status === 'being_checked' ? 'Marked as being checked' : 'Dead zone reopened'),
    invalidate: (qc) => void qc.invalidateQueries({ queryKey: qk.deadzones }),
  });
  return { onDeadzone: (d: Deadzone, status: Deadzone['status']) => mut.mutate({ d, status }), pending: mut.isPending };
}
