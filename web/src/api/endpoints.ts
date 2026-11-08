// One function per endpoint the dashboard uses. Paths and shapes follow ../../openapi.yaml.
import { ApiError, http, requestRaw, type Body, type Query, type Res, type Schemas } from './client';
import type {
  AppEvent, Assignment, ProfileFull, ProfilePublic, Checkin, Deadzone, HeatCell, MeshStats, Offer, OfferMatch, Responder, ServerInfo, SilentDevice, Sos, SosDetail, SosEvent,
} from './models';

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/** Follows next_cursor until exhausted (or `max` items). */
export async function fetchAll<T>(fetchPage: (cursor?: string) => Promise<Page<T>>, max = 1000): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const p = await fetchPage(cursor);
    out.push(...p.data);
    cursor = p.next_cursor ?? undefined;
  } while (cursor && out.length < max);
  return out;
}

// ---- auth
export type AuthTokens = Schemas['AuthTokens'];
export const login = (username: string, password: string) =>
  http.post<AuthTokens>('/auth/login', { username, password } satisfies Body<'/auth/login', 'post'>);
export const logout = (refresh_token: string) => http.post<void>('/auth/logout', { refresh_token });
export const me = () => http.get<Responder>('/auth/me');

// ---- system
export const getHealth = () => http.get<Res<'/health', 'get'>>('/health');
export const getServerInfo = () => http.get<ServerInfo>('/server-info');

// ---- cases
export const listSos = (q: Query) => http.get<Page<Sos>>('/sos', q);
export const getSos = (id: string) => http.get<SosDetail>(`/sos/${id}`);
export const getSosEvents = (id: string) => http.get<{ data: SosEvent[] }>(`/sos/${id}/events`);
export const patchSos = (id: string, body: Body<'/sos/{sosId}', 'patch'>) => http.patch<Sos>(`/sos/${id}`, body);
export const deleteSos = (id: string) => http.del(`/sos/${id}`);
export const retriage = (id: string) => http.post<Sos>(`/sos/${id}/retriage`);
export const mergeSos = (id: string, duplicate_ids: string[]) => http.post<Sos>(`/sos/${id}/merge`, { duplicate_ids });
export const unmergeSos = (id: string, report_id: string) => http.post<Sos>(`/sos/${id}/unmerge`, { report_id });

/** Voice note audio (assignee / admin only). Returns an object URL; the caller revokes it. */
export async function fetchVoiceNote(id: string): Promise<string> {
  const res = await requestRaw('GET', `/sos/${id}/voice-note`, {});
  return URL.createObjectURL(await res.blob());
}

/**
 * GET /devices/{id}/profile answers ProfileFull or ProfilePublic depending on the caller; branch on `view`.
 * The dashboard reads case details from `SosDetail.profile_full` instead, this is here for completeness.
 */
export const getDeviceProfile = (deviceId: string) => http.get<ProfileFull | ProfilePublic>(`/devices/${deviceId}/profile`);
export const isProfileFull = (p: ProfileFull | ProfilePublic): p is ProfileFull => p.view === 'full';

// ---- check-ins
export const listCheckins = (sosId: string) => http.get<{ data: Checkin[] }>(`/sos/${sosId}/checkins`);
export const sendCheckin = (sosId: string, message?: string) =>
  http.post<Checkin>(`/sos/${sosId}/checkins`, message ? { channel: 'app', message } : { channel: 'app' });

// ---- assignments
export const createAssignment = (body: Body<'/assignments', 'post'>) => http.post<Assignment>('/assignments', body);
export const listAssignments = (q: Query) => http.get<Page<Assignment>>('/assignments', q);
export const updateAssignment = (id: string, body: Body<'/assignments/{assignmentId}', 'patch'>) =>
  http.patch<Assignment>(`/assignments/${id}`, body);
export const releaseAssignment = (id: string) => http.del(`/assignments/${id}`);

// ---- responders
export const listResponders = (q: Query = {}) => http.get<Page<Responder>>('/responders', { limit: 200, ...q });
export const createResponder = (b: Body<'/responders', 'post'>) => http.post<Responder>('/responders', b);
export const updateResponder = (id: string, b: Body<'/responders/{responderId}', 'patch'>) => http.patch<Responder>(`/responders/${id}`, b);
export const deleteResponder = (id: string) => http.del(`/responders/${id}`);

// ---- offers
export const listOffers = (q: Query = {}) => http.get<Page<Offer>>('/offers', { limit: 200, ...q });
export const updateOffer = (id: string, b: Body<'/offers/{offerId}', 'patch'>) => http.patch<Offer>(`/offers/${id}`, b);
export const deleteOffer = (id: string) => http.del(`/offers/${id}`);
export const listMatches = (offerId: string) => http.get<{ data: OfferMatch[] }>(`/offers/${offerId}/matches`);
export const createMatch = (offerId: string, sos_id: string) => http.post<OfferMatch>(`/offers/${offerId}/matches`, { sos_id });
export const updateMatch = (offerId: string, matchId: string, status: 'accepted' | 'declined' | 'completed') =>
  http.patch<OfferMatch>(`/offers/${offerId}/matches/${matchId}`, { status });
export const deleteMatch = (offerId: string, matchId: string) => http.del(`/offers/${offerId}/matches/${matchId}`);

// ---- heartbeats (silent devices)
export const listSilent = (q: Query = {}) => http.get<Page<SilentDevice>>('/heartbeats/silent', { limit: 200, ...q });
export const ackSilent = (deviceId: string, acknowledged: boolean, note?: string) =>
  http.patch<SilentDevice>(`/heartbeats/silent/${deviceId}`, { acknowledged, note });
export const promoteSilent = (deviceId: string) => http.post<Sos>(`/heartbeats/silent/${deviceId}/promote`);

// ---- map and mesh
export const getHeat = (bbox: string, cell_km = 1) => http.get<{ data: HeatCell[] }>('/map/heat', { bbox, cell_km });
export const getDeadzones = () => http.get<{ data: Deadzone[] }>('/map/deadzones');
export const patchDeadzone = (id: string, status: Deadzone['status'], note?: string) =>
  http.patch<Deadzone>(`/map/deadzones/${id}`, { status, note });
export const getMeshStats = (window_minutes = 60) => http.get<MeshStats>('/mesh/stats', { window_minutes });

// ---- events
export const listEvents = () => http.get<Page<AppEvent>>('/events', { limit: 100 });
export const createEvent = (b: Body<'/events', 'post'>) => http.post<AppEvent>('/events', b);
export const updateEvent = (id: string, b: Body<'/events/{eventId}', 'patch'>) => http.patch<AppEvent>(`/events/${id}`, b);
export const closeEvent = (id: string) => http.post<AppEvent>(`/events/${id}/close`);
export const purgeEvent = (id: string) => http.post<Res<'/events/{eventId}/purge', 'post'>>(`/events/${id}/purge`);
export const deleteEvent = (id: string) => http.del(`/events/${id}`);

// ---- demo mode (404 unless the server runs with DEMO_MODE)
export const seedDemo = (b: Body<'/mesh/seed', 'post'>) => http.post<{ created: number }>('/mesh/seed', b);
export const clearDemo = () => http.del('/mesh/seed');
export const simulateRelay = (b: Body<'/mesh/simulate', 'post'>) => http.post<Sos>('/mesh/simulate', b);

/**
 * Does this server expose the demo endpoints? They answer 404 outside DEMO_MODE. Seeding zero cases is a
 * no-op when an event is already active, so that is a side-effect free probe. Without an active event the
 * seed route would open a synthetic one, so the caller must not probe then (returns null = unknown).
 */
export async function probeDemo(hasActiveEvent: boolean): Promise<boolean | null> {
  if (!hasActiveEvent) return null;
  try {
    await http.post('/mesh/seed', { center_lat: 0, center_lng: 0, count: 0 });
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return false;
    return e instanceof ApiError && e.status === 403 ? true : null;
  }
}
