import type { components } from '../generated/api';
import type { ProfileRow, SosRow } from '../db/types';
import { allFlags, ageOf, ageRangeOf, type ProfileFullDto, type ProfilePublicDto, type Sensitive, type VulnerabilityFlag, type AgeRange } from './profile';

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
  /** public-only identity source (synced profile columns or a mesh summary); never carries sensitive data */
  profile?: ProfilePublicSource | null;
}

// ------------------------------------------------------------------------------------------ profiles

/** Public identity data: by construction contains nothing sensitive. */
export interface ProfilePublicSource {
  source: 'synced' | 'mesh_summary';
  full_name: string;
  preferred_name?: string | null;
  age_range?: AgeRange;
  flags: VulnerabilityFlag[];
  profile_version: number;
}

/** Public source from a stored row (reads only clear-text columns; `enc` is never touched). */
export function publicSourceFromRow(r: Pick<ProfileRow, 'full_name' | 'preferred_name' | 'birth_year' | 'vuln_flags' | 'profile_version'>, now = new Date()): ProfilePublicSource {
  return {
    source: 'synced', full_name: r.full_name, preferred_name: r.preferred_name, age_range: ageRangeOf(ageOf(r.birth_year, now)),
    flags: allFlags(r.vuln_flags, r.birth_year, now), profile_version: r.profile_version,
  };
}

export function toProfilePublic(src: ProfilePublicSource): ProfilePublicDto {
  return {
    view: 'public', full_name: src.full_name, ...(src.preferred_name ? { preferred_name: src.preferred_name } : {}),
    ...(src.age_range ? { age_range: src.age_range } : {}), vulnerability_flags: src.flags, has_profile: src.source === 'synced',
    source: src.source, profile_version: src.profile_version,
  };
}

/** Full details: the owning device, admins and the ACTIVE assignee of one of the device's cases (same rule as exact location). */
export function canSeeFullProfile(viewer: Viewer, deviceId: string, activeAssigneeOfDevice: boolean): boolean {
  if (viewer.kind === 'device') return viewer.id === deviceId;
  if (viewer.kind !== 'responder') return false;
  return viewer.role === 'admin' || activeAssigneeOfDevice;
}

export interface StoredProfile { row: ProfileRow; sensitive: Sensitive | null }

/**
 * THE choke point for serialising a profile. Anyone not entitled to details gets `ProfilePublic` (name, age bucket, coarse flags);
 * `ProfileFull` is built only after `canSeeFullProfile`. `sensitive` may be null (not decrypted): then even an entitled viewer gets the public view.
 */
export function toProfileView(p: StoredProfile, viewer: Viewer, activeAssigneeOfDevice: boolean, now = new Date()): ProfileFullDto | ProfilePublicDto {
  const r = p.row;
  if (!p.sensitive || !canSeeFullProfile(viewer, r.device_id, activeAssigneeOfDevice)) return toProfilePublic(publicSourceFromRow(r, now));
  const age_range = ageRangeOf(ageOf(r.birth_year, now));
  return {
    view: 'full', device_id: r.device_id, profile_version: r.profile_version, full_name: r.full_name,
    ...(r.preferred_name ? { preferred_name: r.preferred_name } : {}), ...(r.birth_year != null ? { birth_year: r.birth_year } : {}),
    ...(age_range ? { age_range } : {}), vulnerability_flags: allFlags(r.vuln_flags, r.birth_year, now),
    ...p.sensitive,
    consent: { accepted: true, version: r.consent_version, accepted_at: r.consent_accepted_at.toISOString() },
    synthetic: r.synthetic, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
  };
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
    profile: input.profile ? toProfilePublic(input.profile) : null,
    synthetic: row.synthetic,
    version: row.version,
    created_at: row.created_at.toISOString(),
    received_at: row.received_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
