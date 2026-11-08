// Pure helpers for the person (profile) data on cases. No React, no network.
// Privacy rule: the public view (name, age range, coarse flags) is shown to every dashboard user; everything in
// ProfileFull is shown only when the API itself returned `profile_full`. Nothing here infers sensitive data from flags.
import type { AgeRange, ProfileFull, ProfilePublic, Sos, VulnerabilityFlag } from '../api/models';

export const AGE_LABEL: Record<AgeRange, string> = {
  '0-12': 'Child (0-12)',
  '13-17': 'Teen (13-17)',
  '18-34': 'Age 18-34',
  '35-49': 'Age 35-49',
  '50-64': 'Age 50-64',
  '65-79': 'Age 65-79',
  '80+': 'Age 80+',
};

export function ageLabel(a: AgeRange | undefined | null): string | null {
  return a ? (AGE_LABEL[a] ?? `Age ${a}`) : null;
}

/** Short chip text for an age range ("65-79", "80+"). */
export const ageChip = (a: AgeRange | undefined | null): string | null => (a ? a : null);

export interface FlagMeta {
  short: string;
  label: string;
  tip: string;
}

/** `tip` is a plain description of the coarse flag. It deliberately does not claim anything specific about the person. */
export const FLAG_META: Record<VulnerabilityFlag, FlagMeta> = {
  oxygen: { short: 'O₂', label: 'Oxygen dependent', tip: 'Depends on supplemental oxygen' },
  mobility: { short: 'Mobility', label: 'Mobility needs', tip: 'Needs help moving: wheelchair, cannot walk or walks with an aid' },
  medical: { short: 'Medical', label: 'Medical needs', tip: 'Has medical conditions, medications or allergies on file' },
  sensory: { short: 'Sensory', label: 'Sensory impairment', tip: 'Vision or hearing impaired' },
  cognitive: { short: 'Cognitive', label: 'Cognitive needs', tip: 'Has a cognitive need; may need extra support to follow instructions' },
  elderly: { short: 'Elderly', label: 'Elderly (65+)', tip: 'Age 65 or older' },
  child: { short: 'Child', label: 'Child (12 or younger)', tip: 'Age 12 or younger' },
};

/** Most urgent first so truncation in small cards keeps the important ones. */
const FLAG_ORDER: VulnerabilityFlag[] = ['oxygen', 'mobility', 'medical', 'child', 'elderly', 'sensory', 'cognitive'];

export function sortFlags(flags: readonly VulnerabilityFlag[] | undefined): VulnerabilityFlag[] {
  const known = new Set<VulnerabilityFlag>(flags ?? []);
  return FLAG_ORDER.filter((f) => known.has(f));
}

export function flagsSummary(flags: readonly VulnerabilityFlag[] | undefined): string {
  return sortFlags(flags).map((f) => FLAG_META[f].label).join(', ');
}

export interface DisplayName {
  /** Primary label: the full name, or "Unknown person". */
  primary: string;
  /** Preferred name when it adds information. */
  preferred?: string;
  known: boolean;
  /** Subtle hint under the name when the profile is missing or only came from the SOS message. */
  hint?: string;
}

export const UNKNOWN_PERSON = 'Unknown person';
export const HINT_UNSYNCED = 'profile not synced';
export const HINT_MESH_SUMMARY = 'Name from SOS message; full profile not synced yet';

export function displayName(p: ProfilePublic | null | undefined): DisplayName {
  const name = p?.full_name?.trim();
  if (!p || !name) return { primary: UNKNOWN_PERSON, known: false, hint: HINT_UNSYNCED };
  const pref = p.preferred_name?.trim();
  const preferred = pref && pref.toLowerCase() !== name.toLowerCase() ? pref : undefined;
  const hint = p.has_profile ? undefined : p.source === 'mesh_summary' ? HINT_MESH_SUMMARY : HINT_UNSYNCED;
  return { primary: name, preferred, known: true, hint };
}

/** Single-string version: `Maria Elena Gonzalez "Elena"`. */
export function nameLine(p: ProfilePublic | null | undefined): string {
  const d = displayName(p);
  return d.preferred ? `${d.primary} “${d.preferred}”` : d.primary;
}

export type PersonAccess =
  /** `profile_full` came back: show every detail section. */
  | 'unlocked'
  /** A synced profile exists but this viewer cannot see details and may claim the case. */
  | 'locked_claim'
  /** A synced profile exists, but the viewer is a volunteer who can never see details. */
  | 'locked_volunteer'
  /** Someone else holds the case. Details are for that responder and admins. */
  | 'locked_other'
  /** No synced profile, so there is nothing to unlock (and nothing to tell). */
  | 'unsynced';

export interface AccessInput {
  profile?: ProfilePublic | null;
  profile_full?: ProfileFull | null;
  assignment?: Sos['assignment'];
}

/**
 * Decide locked vs unlocked from what the server returned, never from flags. `canAct` is false for volunteers.
 * Only the presence of `profile_full` unlocks; role and assignment only choose the wording of the locked state.
 */
export function personAccess(c: AccessInput, canAct: boolean, myId?: string): PersonAccess {
  if (c.profile_full) return 'unlocked';
  if (!c.profile?.has_profile) return 'unsynced';
  if (!canAct) return 'locked_volunteer';
  const a = c.assignment;
  const held = !!a && ['assigned', 'en_route', 'on_scene'].includes(a.status);
  if (held && a.responder_id !== myId) return 'locked_other';
  return 'locked_claim';
}

export const LOCKED_TEXT: Record<Exclude<PersonAccess, 'unlocked' | 'unsynced'>, string> = {
  locked_claim: 'Claim this case to see medical and contact details',
  locked_volunteer: 'Only assigned responders and admins can see details',
  locked_other: 'Only the assigned responder and admins can see details',
};

/** Why the viewer can see the sensitive part. */
export function unlockedReason(isAdmin: boolean, assignedToMe: boolean): string {
  if (assignedToMe && !isAdmin) return 'Visible to you because you are assigned to this case.';
  if (isAdmin && !assignedToMe) return 'Visible to you because you are an admin.';
  return 'Visible to you because you are assigned to this case and an admin.';
}

/** Digits (and one leading +) only, for `tel:` links. Returns null when there are not enough digits to dial. */
export function telHref(phone: string | undefined | null): string | null {
  if (!phone) return null;
  const t = phone.trim();
  const digits = t.replace(/\D/g, '');
  if (digits.length < 3) return null;
  return `tel:${t.startsWith('+') ? '+' : ''}${digits}`;
}

const NEED_LABEL: Record<string, string> = {
  wheelchair: 'Wheelchair',
  cannot_walk: 'Cannot walk',
  walks_with_aid: 'Walks with an aid',
  vision_impaired: 'Vision impaired',
  hearing_impaired: 'Hearing impaired',
  cognitive: 'Cognitive need',
  oxygen_dependent: 'Oxygen dependent',
  other: 'Other need',
};
export const needLabel = (n: string): string => NEED_LABEL[n] ?? n.replace(/_/g, ' ');

export function petsLabel(pets: { kind: string; count?: number }[] | undefined): string | null {
  if (!pets?.length) return null;
  return pets.map((p) => `${p.count && p.count > 1 ? `${p.count} ` : ''}${p.kind}${p.count && p.count > 1 ? 's' : ''}`).join(', ');
}

/** True when the object has at least one non-empty value (used to hide empty sections). */
export function hasAny(o: object | undefined | null): boolean {
  if (!o) return false;
  return Object.values(o).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== ''));
}

/** Names searched client-side (the server's `q` only covers notes). */
export function searchableNames(c: Pick<Sos, 'profile'>): string[] {
  return [c.profile?.full_name ?? '', c.profile?.preferred_name ?? ''];
}
