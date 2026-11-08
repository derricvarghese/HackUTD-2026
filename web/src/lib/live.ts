// Pure reducers for live (WebSocket) updates. Components never mutate; query caches are replaced with these results.
import type { Assignment, Checkin, Deadzone, Offer, OfferMatch, SilentDevice, Sos, WsFrame } from '../api/models';
import { deviceShortId, isOpenStatus, shortId } from './tier';

/** API order for `sort=priority`: score desc, silent first, then oldest first. */
export function comparePriority(a: Sos, b: Sos): number {
  if (b.score !== a.score) return b.score - a.score;
  if (!!b.silent !== !!a.silent) return a.silent ? -1 : 1;
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}

export const sortByPriority = (list: Sos[]): Sos[] => [...list].sort(comparePriority);

/** Insert/replace a case in the open set; non-open cases (resolved, merged, closed) are dropped from it. */
export function upsertCase(list: Sos[], c: Sos): Sos[] {
  const rest = list.filter((x) => x.id !== c.id);
  if (!isOpenStatus(c.status)) return rest.length === list.length ? list : sortByPriority(rest);
  return sortByPriority([...rest, c]);
}

export function removeCases(list: Sos[], ids: string[]): Sos[] {
  const s = new Set(ids);
  return list.some((x) => s.has(x.id)) ? list.filter((x) => !s.has(x.id)) : list;
}

/** Merge a catch-up batch (GET /sos?updated_since=...) into the open set. */
export function mergeUpdated(list: Sos[], updated: Sos[]): Sos[] {
  return updated.reduce(upsertCase, list);
}

export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [item, ...list];
  const next = [...list];
  next[i] = item;
  return next;
}

export function upsertSilent(list: SilentDevice[], d: SilentDevice): SilentDevice[] {
  const rest = list.filter((x) => x.device_id !== d.device_id);
  if (d.acknowledged) return rest;
  return [d, ...rest].sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0) || (b.silent_for_seconds ?? 0) - (a.silent_for_seconds ?? 0));
}

export const removeSilent = (list: SilentDevice[], deviceId: string): SilentDevice[] => list.filter((x) => x.device_id !== deviceId);

// ---- live feed
export type FeedTone = 'alert' | 'ok' | 'info';
export interface FeedItem {
  id: string;
  ts: string;
  tone: FeedTone;
  text: string;
}

const clockHops = (c: Sos) => (c.hop?.hop_count !== undefined ? ` via ${c.hop.hop_count} hop${c.hop.hop_count === 1 ? '' : 's'}` : '');

/** Human sentence for a websocket frame, or null when the frame is not feed-worthy. */
export function describeFrame(f: WsFrame): FeedItem | null {
  const ts = f.ts;
  const id = `${f.event}-${ts}-${Math.random().toString(36).slice(2, 7)}`;
  switch (f.event) {
    case 'sos.created': {
      const c = f.data as Sos;
      return { id, ts, tone: c.score >= 80 ? 'alert' : 'info', text: `${shortId(c.id)} received${c.channel === 'mesh' ? clockHops(c) : ' from the app'}, score ${c.score}` };
    }
    case 'sos.silent': {
      const c = f.data as Sos;
      return { id, ts, tone: 'alert', text: `${shortId(c.id)} went silent, score now ${c.score}` };
    }
    case 'sos.merged': {
      const m = f.data as { primary_id: string; merged_ids: string[] };
      return { id, ts, tone: 'info', text: `${m.merged_ids.length} report${m.merged_ids.length === 1 ? '' : 's'} merged into ${shortId(m.primary_id)}` };
    }
    case 'assignment.created': {
      const a = f.data as Assignment;
      return { id, ts, tone: 'ok', text: `${a.responder_name ?? 'A responder'} claimed ${shortId(a.sos_id)}` };
    }
    case 'assignment.updated': {
      const a = f.data as Assignment;
      const what = a.status === 'en_route' ? `is en route${a.eta_minutes ? ` (ETA ${a.eta_minutes} min)` : ''}` : a.status === 'on_scene' ? 'is on scene' : a.status === 'resolved' ? `resolved it${a.outcome ? ` (${a.outcome.replace(/_/g, ' ')})` : ''}` : a.status === 'released' ? 'released the case' : `is ${a.status.replace(/_/g, ' ')}`;
      return { id, ts, tone: a.status === 'resolved' ? 'ok' : 'info', text: `${a.responder_name ?? 'Responder'} ${what} on ${shortId(a.sos_id)}` };
    }
    case 'checkin.sent': {
      const c = f.data as Checkin;
      return { id, ts, tone: 'info', text: `Check-in ${c.attempt ? `#${c.attempt} ` : ''}sent for ${shortId(c.sos_id)}` };
    }
    case 'checkin.responded': {
      const c = f.data as Checkin;
      return { id, ts, tone: c.response === 'need_help' ? 'alert' : 'ok', text: `${shortId(c.sos_id)} replied to check-in${c.response ? `: ${c.response.replace(/_/g, ' ')}` : ''}` };
    }
    case 'heartbeat.silent': {
      const d = f.data as SilentDevice;
      return { id, ts, tone: d.status === 'distress' ? 'alert' : 'info', text: `${deviceShortId(d.device_id)} stopped heartbeating (${d.status})` };
    }
    case 'heartbeat.resumed': {
      const d = f.data as SilentDevice;
      return { id, ts, tone: 'ok', text: `${deviceShortId(d.device_id)} is heartbeating again` };
    }
    case 'offer.created': {
      const o = f.data as Offer;
      return { id, ts, tone: 'info', text: `New offer from a neighbour: ${o.kind}${o.description ? `, ${o.description}` : ''}` };
    }
    case 'offer.matched': {
      const m = f.data as OfferMatch;
      return { id, ts, tone: 'ok', text: `Offer matched to ${shortId(m.sos_id)} (${m.distance_km.toFixed(1)} km)` };
    }
    case 'deadzones.updated': {
      const n = (f.data as { data?: Deadzone[] } | undefined)?.data?.length;
      return n === undefined ? null : { id, ts, tone: 'info', text: `Dead zones updated: ${n} open or tracked` };
    }
    default:
      return null;
  }
}

export function pushFeed(feed: FeedItem[], item: FeedItem, max = 40): FeedItem[] {
  return [item, ...feed].slice(0, max);
}

/** Initial feed entries derived from loaded cases so the panel is useful before any websocket event arrives. */
export function deriveFeed(cases: Sos[], max = 8): FeedItem[] {
  const items: FeedItem[] = [];
  for (const c of cases) {
    items.push({ id: `c-${c.id}`, ts: c.received_at ?? c.created_at, tone: c.score >= 80 ? 'alert' : 'info', text: `${shortId(c.id)} received${c.channel === 'mesh' ? clockHops(c) : ' from the app'}, score ${c.score}` });
    if (c.silent && c.silent_since) items.push({ id: `s-${c.id}`, ts: c.silent_since, tone: 'alert', text: `${shortId(c.id)} went silent, priority raised to ${c.score}` });
    if (c.assignment) items.push({ id: `a-${c.id}`, ts: c.updated_at ?? c.created_at, tone: 'ok', text: `${c.assignment.responder_name ?? 'A responder'} is ${c.assignment.status.replace(/_/g, ' ')} on ${shortId(c.id)}` });
  }
  return items.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, max);
}

