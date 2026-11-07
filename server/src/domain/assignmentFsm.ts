export type AssignmentStatus = 'assigned' | 'en_route' | 'on_scene' | 'resolved' | 'released' | 'cancelled';
export type SosStatus = 'reported' | 'assigned' | 'en_route' | 'on_scene' | 'resolved' | 'merged' | 'closed';

const NEXT: Record<AssignmentStatus, AssignmentStatus[]> = {
  assigned: ['en_route', 'released', 'cancelled'],
  en_route: ['on_scene', 'released', 'cancelled'],
  on_scene: ['resolved', 'released', 'cancelled'],
  resolved: [],
  released: [],
  cancelled: [],
};
export const isTerminal = (s: AssignmentStatus) => NEXT[s].length === 0;
/** Same-status updates (ETA edit) are allowed on non-terminal states. */
export const canTransition = (from: AssignmentStatus, to: AssignmentStatus) =>
  from === to ? !isTerminal(from) : NEXT[from].includes(to);

/** Case status after an assignment status change: released/cancelled return the case to the queue. */
export const sosStatusFor = (a: AssignmentStatus): SosStatus =>
  a === 'released' || a === 'cancelled' ? 'reported' : a;

export type SosEventType = 'assigned' | 'en_route' | 'on_scene' | 'resolved' | 'released';
export const eventTypeFor = (a: AssignmentStatus): SosEventType => (a === 'cancelled' ? 'released' : a);
