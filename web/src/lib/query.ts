import type { Query } from '../api/client';
import type { Sos } from '../api/models';
import { searchableNames } from './profile';
import { CRITICAL_MIN, HIGH_MIN } from './tier';

export type QueueTab = 'all' | 'critical' | 'high' | 'silent' | 'assigned';

export interface QueueFilters {
  tab: QueueTab;
  search?: string;
  includeResolved?: boolean;
  assignedTo?: 'me' | 'none';
}

const OPEN = ['reported', 'assigned', 'en_route', 'on_scene'];

/** Server-side part of the queue filters. Tabs the API cannot express (high band, assigned) are finished by matchesTab. */
export function buildSosQuery(f: QueueFilters, limit = 200): Query {
  const q: Query = { sort: 'priority', limit, status: f.includeResolved ? [...OPEN, 'resolved'] : OPEN };
  switch (f.tab) {
    case 'critical':
      q.min_score = CRITICAL_MIN;
      break;
    case 'high':
      q.min_score = HIGH_MIN;
      break;
    case 'silent':
      q.silent = true;
      break;
    case 'assigned':
      q.status = ['assigned', 'en_route', 'on_scene'];
      break;
  }
  if (f.search?.trim()) q.q = f.search.trim();
  if (f.assignedTo) q.assigned_to = f.assignedTo;
  return q;
}

/** Client-side tab predicate (also used for tab counts over the loaded open set). */
export function matchesTab(c: Sos, tab: QueueTab): boolean {
  if (c.category === 'safe' || c.score < 20) return false;
  switch (tab) {
    case 'all':
      return true;
    case 'critical':
      return c.score >= CRITICAL_MIN;
    case 'high':
      return c.score >= HIGH_MIN && c.score < CRITICAL_MIN;
    case 'silent':
      return !!c.silent;
    case 'assigned':
      return !!c.assignment && ['assigned', 'en_route', 'on_scene'].includes(c.assignment.status);
  }
}

/** Case-insensitive match over the visible text of a case, including the person's name (used for client-side search; the API's `q` only searches notes). */
export function matchesSearch(c: Sos, q: string, display: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [display, c.text ?? '', c.id, c.category, c.assignment?.responder_name ?? '', ...searchableNames(c)].some((x) => x.toLowerCase().includes(s));
}

/** bbox string for the API: min_lng,min_lat,max_lng,max_lat. */
export function bboxParam(b: { min_lat: number; min_lng: number; max_lat: number; max_lng: number }): string {
  return [b.min_lng, b.min_lat, b.max_lng, b.max_lat].map((n) => +n.toFixed(5)).join(',');
}
