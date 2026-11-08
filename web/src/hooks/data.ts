// react-query hooks. Live updates patch these caches (see live.tsx); everything else refetches on demand.
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as api from '../api/endpoints';
import { ApiError } from '../api/client';
import type { Assignment, Sos } from '../api/models';
import { bboxParam, buildSosQuery, type QueueFilters } from '../lib/query';
import { sortByPriority } from '../lib/live';
import { useUi } from '../state/ui';

export const qk = {
  open: ['cases', 'open'] as const,
  cases: (f: QueueFilters) => ['cases', 'list', f] as const,
  detail: (id: string) => ['sos', id] as const,
  checkins: (id: string) => ['checkins', id] as const,
  silent: ['silent'] as const,
  deadzones: ['deadzones'] as const,
  heat: ['heat'] as const,
  mesh: ['mesh-stats'] as const,
  serverInfo: ['server-info'] as const,
  responders: ['responders'] as const,
  offers: ['offers'] as const,
  matches: (id: string) => ['matches', id] as const,
  assignments: ['assignments'] as const,
  events: ['events'] as const,
  health: ['health'] as const,
};

/** All open cases, ranked. The single source of truth for the overview, map, queue counts and feed. */
export const useOpenCases = () =>
  useQuery({ queryKey: qk.open, queryFn: async () => sortByPriority(await api.fetchAll((cursor) => api.listSos({ ...buildSosQuery({ tab: 'all' }), cursor }), 1000)) });

/** Queue view with server-side filters (tabs, search, resolved). */
export const useCaseList = (f: QueueFilters) =>
  useQuery({
    queryKey: qk.cases(f),
    queryFn: () => api.fetchAll((cursor) => api.listSos({ ...buildSosQuery(f), cursor }), 1000),
    placeholderData: keepPreviousData,
  });

export const useCaseDetail = (id: string | null) =>
  useQuery({ queryKey: qk.detail(id ?? ''), queryFn: () => api.getSos(id as string), enabled: !!id, retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2 });

export const useCaseEvents = (id: string | null) =>
  useQuery({ queryKey: ['sos-events', id], queryFn: async () => (await api.getSosEvents(id as string)).data, enabled: !!id });

export const useCheckins = (id: string | null) =>
  useQuery({ queryKey: qk.checkins(id ?? ''), queryFn: async () => (await api.listCheckins(id as string)).data, enabled: !!id, staleTime: 15_000 });

export const useSilent = () => useQuery({ queryKey: qk.silent, queryFn: async () => (await api.listSilent()).data });
export const useDeadzones = () => useQuery({ queryKey: qk.deadzones, queryFn: async () => (await api.getDeadzones()).data });
/** Heat cells for the current map view (the endpoint requires a bbox). The box is padded and rounded so small pans reuse the cache. */
export const useHeat = (enabled: boolean, bounds: { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | null) => {
  const box = bounds ? padBox(bounds) : null;
  return useQuery({
    queryKey: [...qk.heat, box],
    queryFn: async () => (await api.getHeat(box as string, 1)).data,
    enabled: enabled && !!box,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
};

function padBox(b: { min_lat: number; min_lng: number; max_lat: number; max_lng: number }): string {
  const dy = (b.max_lat - b.min_lat) * 0.25;
  const dx = (b.max_lng - b.min_lng) * 0.25;
  return bboxParam({ min_lat: Math.floor((b.min_lat - dy) * 20) / 20, min_lng: Math.floor((b.min_lng - dx) * 20) / 20, max_lat: Math.ceil((b.max_lat + dy) * 20) / 20, max_lng: Math.ceil((b.max_lng + dx) * 20) / 20 });
}
export const useMeshStats = () => useQuery({ queryKey: qk.mesh, queryFn: () => api.getMeshStats(60) });
export const useServerInfo = () => useQuery({ queryKey: qk.serverInfo, queryFn: api.getServerInfo, staleTime: 60_000 });
export const useResponders = () => useQuery({ queryKey: qk.responders, queryFn: async () => (await api.listResponders()).data });
export const useOffers = () => useQuery({ queryKey: qk.offers, queryFn: async () => (await api.listOffers()).data });
export const useActiveAssignments = () =>
  useQuery({ queryKey: [...qk.assignments, 'active'], queryFn: () => api.fetchAll((cursor) => api.listAssignments({ status: ['assigned', 'en_route', 'on_scene'], cursor, limit: 200 })) });
export const useEvents = () => useQuery({ queryKey: qk.events, queryFn: async () => (await api.listEvents()).data });
export const useHealth = () => useQuery({ queryKey: qk.health, queryFn: api.getHealth, refetchInterval: 60_000, staleTime: 30_000 });

/** Matches for every offer (small N), keyed per offer so ws events can invalidate them. */
export const useOfferMatches = (offerId: string) => useQuery({ queryKey: qk.matches(offerId), queryFn: async () => (await api.listMatches(offerId)).data });

export function invalidateCase(qc: QueryClient, id?: string) {
  void qc.invalidateQueries({ queryKey: ['cases'] });
  if (id) {
    void qc.invalidateQueries({ queryKey: qk.detail(id) });
    void qc.invalidateQueries({ queryKey: ['sos-events', id] });
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? e.message : e.message || e.code;
  return e instanceof Error ? e.message : 'Something went wrong';
}

/** Mutation helper: toast on failure, optional success toast, invalidate on settle. */
export function useAction<V, R>(fn: (v: V) => Promise<R>, opts: { success?: string | ((r: R) => string); invalidate?: (qc: QueryClient, r?: R, v?: V) => void; onError?: (e: unknown, v: V) => boolean | void } = {}) {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (opts.success) toast('success', typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.invalidate?.(qc, r, v);
    },
    onError: (e, v) => {
      if (opts.onError?.(e, v)) return;
      toast('error', errorMessage(e));
    },
  });
}

/** Claim / advance / release / resolve with the 409 cases explained instead of a generic failure. */
export function conflictMessage(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const a = (e.details as { assignment?: { responder_name?: string } } | undefined)?.assignment;
  if (a?.responder_name) return `Already claimed by ${a.responder_name}. The queue has been refreshed.`;
  return `${e.message}. The case changed; refreshed.`;
}

export function useAssignmentActions() {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const done = (sosId?: string) => {
    invalidateCase(qc, sosId);
    void qc.invalidateQueries({ queryKey: qk.assignments });
    void qc.invalidateQueries({ queryKey: qk.responders });
    void qc.invalidateQueries({ queryKey: qk.open });
  };
  const onError = (sosId?: string) => (e: unknown) => {
    toast('error', conflictMessage(e) ?? errorMessage(e));
    if (e instanceof ApiError && e.status === 409) done(sosId);
  };
  const claim = useMutation({
    mutationFn: (v: { sos: Sos; responderId?: string; eta?: number }) => api.createAssignment({ sos_id: v.sos.id, responder_id: v.responderId, eta_minutes: v.eta }),
    onSuccess: (_a, v) => {
      toast('success', 'Case claimed');
      done(v.sos.id);
    },
    onError: (e, v) => onError(v.sos.id)(e),
  });
  const update = useMutation({
    mutationFn: (v: { assignment: Pick<Assignment, 'id' | 'sos_id'>; status?: Assignment['status']; eta?: number; outcome?: 'rescued' | 'safe_on_arrival' | 'false_alarm' | 'unreachable' | 'referred'; note?: string }) =>
      api.updateAssignment(v.assignment.id, { status: v.status, eta_minutes: v.eta, outcome: v.outcome, note: v.note }),
    onSuccess: (a, v) => {
      toast('success', v.status === 'resolved' ? 'Case resolved' : 'Updated');
      done(a.sos_id);
    },
    onError: (e, v) => onError(v.assignment.sos_id)(e),
  });
  const release = useMutation({
    mutationFn: (v: { assignment: Pick<Assignment, 'id' | 'sos_id'> }) => api.releaseAssignment(v.assignment.id),
    onSuccess: (_r, v) => {
      toast('success', 'Case released back to the queue');
      done(v.assignment.sos_id);
    },
    onError: (e, v) => onError(v.assignment.sos_id)(e),
  });
  return { claim, update, release };
}
