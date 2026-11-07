import type { components } from '../generated/api';
import type { SosRow } from '../db/types';

export type Sos = components['schemas']['Sos'];
export type TriageReason = components['schemas']['TriageReason'];
export type AssignmentSummary = components['schemas']['AssignmentSummary'];

export type Viewer =
  | { kind: 'responder'; id: string; role: 'responder' | 'volunteer' | 'admin' }
  | { kind: 'device'; id: string }
  | { kind: 'anon' };

export const ACTIVE_ASSIGNMENT = ['assigned', 'en_route', 'on_scene'] as const;
export const isActiveAssignment = (s: string) => (ACTIVE_ASSIGNMENT as readonly string[]).includes(s);

/** Exact location is visible only to admins and the responder holding the ACTIVE claim. */
export function canSeeExact(viewer: Viewer, activeAssigneeId: string | null | undefined): boolean {
  if (viewer.kind !== 'responder') return false;
  if (viewer.role === 'admin') return true;
  return !!activeAssigneeId && viewer.id === activeAssigneeId;
}

export function redactLocation<T extends { lat: number; lng: number }>(viewer: Viewer, activeAssigneeId: string | null | undefined, loc: T | null): T | null {
  return loc && canSeeExact(viewer, activeAssigneeId) ? loc : null;
}

export interface SosViewInput {
  row: SosRow;
  reasons: TriageReason[];
  /** current active assignment, if any */
  assignment: (AssignmentSummary & { status: string }) | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * THE choke point for serialising a case. Every REST response and WebSocket frame goes through here, so a
 * `location` can never leak to a viewer who is not the active assignee or an admin.
 */
export function toSosView(input: SosViewInput, viewer: Viewer): Sos {
  const { row, reasons, assignment } = input;
  const activeAssignee = assignment && isActiveAssignment(assignment.status) ? assignment.responder_id : null;
  const exact = canSeeExact(viewer, activeAssignee) && row.lat != null && row.lng != null;
  return {
    id: row.id,
    sender_hash: row.sender_hash,
    channel: row.channel,
    category: row.category,
    status: row.status,
    approx_location: { lat: row.approx_lat, lng: row.approx_lng, radius_m: 1000 },
    location: exact ? { lat: row.lat!, lng: row.lng! } : null,
    text: row.text,
    people_count: row.people_count,
    score: row.score_override ?? row.score,
    confidence: row.confidence,
    reasons,
    event_id: row.event_id,
    has_voice_note: row.has_voice_note,
    silent: row.silent,
    silent_since: iso(row.silent_since),
    last_heard_at: row.last_heard_at.toISOString(),
    hop: {
      hop_count: row.hop_count,
      max_hops: row.max_hops,
      hop_path: row.hop_path,
      gateway_device_id: row.gateway_device_id,
      original_created_at: row.original_created_at.toISOString(),
    },
    merged_into: row.merged_into,
    duplicate_count: row.duplicate_count,
    assignment: assignment
      ? { id: assignment.id, responder_id: assignment.responder_id, responder_name: assignment.responder_name, status: assignment.status as AssignmentSummary['status'], eta_minutes: assignment.eta_minutes ?? null }
      : null,
    synthetic: row.synthetic,
    version: row.version,
    created_at: row.created_at.toISOString(),
    received_at: row.received_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
