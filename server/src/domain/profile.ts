import type { components } from '../generated/api';
import { invalid } from '../errors';

export type ProfileInput = components['schemas']['ProfileInput'];
export type ProfileFullDto = components['schemas']['ProfileFull'];
export type ProfilePublicDto = components['schemas']['ProfilePublic'];
export type ProfileSummary = components['schemas']['ProfileSummary'];
export type AgeRange = components['schemas']['AgeRange'];
export type VulnerabilityFlag = components['schemas']['VulnerabilityFlag'];

/** The part of a profile that is encrypted at rest (everything not needed to show a name / coarse flags). */
export interface Sensitive {
  languages?: string[];
  phone?: string;
  appearance?: ProfileInput['appearance'];
  medical?: ProfileInput['medical'];
  mobility?: ProfileInput['mobility'];
  household?: ProfileInput['household'];
  home_address?: string;
  emergency_contact?: ProfileInput['emergency_contact'];
  notes?: string;
}

export const AGE_RANGES: AgeRange[] = ['0-12', '13-17', '18-34', '35-49', '50-64', '65-79', '80+'];
export const FLAG_ORDER: VulnerabilityFlag[] = ['oxygen', 'mobility', 'medical', 'sensory', 'cognitive', 'elderly', 'child'];
export const PHONE_RE = /^\+?[0-9][0-9 ()\-.]{4,24}[0-9]$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const ageOf = (birthYear: number | null | undefined, now = new Date()): number | null =>
  birthYear == null ? null : Math.max(0, now.getUTCFullYear() - birthYear);

export function ageRangeOf(age: number | null): AgeRange | undefined {
  if (age == null) return undefined;
  if (age <= 12) return '0-12';
  if (age <= 17) return '13-17';
  if (age <= 34) return '18-34';
  if (age <= 49) return '35-49';
  if (age <= 64) return '50-64';
  if (age <= 79) return '65-79';
  return '80+';
}

/** Lowercase, strip diacritics and punctuation, collapse spaces. Used only for cheap exact-match dedupe. */
export function normalizeName(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Flags that do not depend on the current date (stored in a queryable column). */
export function staticFlags(s: Sensitive): VulnerabilityFlag[] {
  const out = new Set<VulnerabilityFlag>();
  const needs = s.mobility?.needs ?? [];
  if (needs.some((n) => n === 'wheelchair' || n === 'cannot_walk' || n === 'walks_with_aid')) out.add('mobility');
  if (needs.includes('oxygen_dependent')) out.add('oxygen');
  if (needs.includes('vision_impaired') || needs.includes('hearing_impaired')) out.add('sensory');
  if (needs.includes('cognitive')) out.add('cognitive');
  const m = s.medical;
  if (m && ((m.conditions?.length ?? 0) > 0 || (m.medications?.length ?? 0) > 0 || (m.allergies?.length ?? 0) > 0)) out.add('medical');
  return [...out];
}

export function allFlags(stored: string[], birthYear: number | null, now = new Date()): VulnerabilityFlag[] {
  const set = new Set(stored as VulnerabilityFlag[]);
  const age = ageOf(birthYear, now);
  if (age != null && age >= 65) set.add('elderly');
  if (age != null && age <= 12) set.add('child');
  return FLAG_ORDER.filter((f) => set.has(f));
}

// ------------------------------------------------------------------------------------------ validation

const badChars = (s: string, multiline = false) => (multiline ? CONTROL.test(s) : CONTROL.test(s) || /[\n\r\t]/.test(s));

/**
 * Domain validation on top of the OpenAPI schema (lengths/enums/pattern are already checked there). Throws 422 naming fields only:
 * messages never echo submitted values. Returns a cleaned copy (trimmed, de-duplicated lists, blanks dropped).
 */
export function validateProfileInput(b: ProfileInput, opts: { consentVersion: string; now?: Date }): ProfileInput {
  const now = opts.now ?? new Date();
  const f: Record<string, string> = {};
  const text = (path: string, v: string | undefined, max: number, multiline = false): string | undefined => {
    if (v === undefined) return undefined;
    const t = v.trim();
    if (!t) { f[path] = 'must not be blank'; return undefined; }
    if (t.length > max) f[path] = `must be at most ${max} characters`;
    if (badChars(t, multiline)) f[path] = 'contains control characters';
    return t;
  };
  const list = (path: string, v: string[] | undefined, maxItems: number, maxLen: number): string[] | undefined => {
    if (v === undefined) return undefined;
    const out = [...new Set(v.map((x) => x.trim()).filter(Boolean))];
    if (out.length > maxItems) f[path] = `at most ${maxItems} items`;
    out.forEach((x) => { if (x.length > maxLen || badChars(x)) f[path] = 'invalid item'; });
    return out;
  };

  if (!b.consent || b.consent.accepted !== true) f['consent.accepted'] = 'must be true';
  else if (b.consent.version !== opts.consentVersion) f['consent.version'] = 'does not match the current consent version (see /server-info profile_consent_version)';
  const full_name = text('full_name', b.full_name, 120);
  const out: ProfileInput = { full_name: full_name ?? '', consent: { accepted: true, version: b.consent?.version ?? '', accepted_at: b.consent?.accepted_at ?? now.toISOString() } };
  const preferred = text('preferred_name', b.preferred_name, 60);
  if (preferred) out.preferred_name = preferred;
  if (b.birth_year !== undefined) {
    if (b.birth_year < 1900 || b.birth_year > now.getUTCFullYear()) f.birth_year = `must be between 1900 and ${now.getUTCFullYear()}`;
    else out.birth_year = b.birth_year;
  }
  const languages = list('languages', b.languages, 8, 35);
  if (languages?.length) {
    languages.forEach((l) => { if (!/^[\p{L}\p{M}0-9 _-]{2,35}$/u.test(l)) f.languages = 'must be BCP-47 tags or language names'; });
    out.languages = languages;
  }
  if (b.phone !== undefined) { const p = b.phone.trim(); if (!PHONE_RE.test(p)) f.phone = 'must look like an E.164 phone number'; else out.phone = p; }
  if (b.appearance) {
    const a: NonNullable<ProfileInput['appearance']> = {};
    if (b.appearance.height_cm !== undefined) a.height_cm = b.appearance.height_cm;
    for (const k of ['hair', 'clothing', 'distinguishing_marks'] as const) { const t = text(`appearance.${k}`, b.appearance[k], 300); if (t) a[k] = t; }
    if (Object.keys(a).length) out.appearance = a;
  }
  if (b.medical) {
    const m: NonNullable<ProfileInput['medical']> = {};
    for (const k of ['conditions', 'medications', 'allergies'] as const) { const l = list(`medical.${k}`, b.medical[k], 20, 100); if (l?.length) m[k] = l; }
    if (b.medical.blood_type) m.blood_type = b.medical.blood_type;
    if (Object.keys(m).length) out.medical = m;
  }
  if (b.mobility) {
    const m: NonNullable<ProfileInput['mobility']> = {};
    if (b.mobility.needs?.length) m.needs = [...new Set(b.mobility.needs)];
    const n = text('mobility.notes', b.mobility.notes, 300, true);
    if (n) m.notes = n;
    if (Object.keys(m).length) out.mobility = m;
  }
  if (b.household) {
    const h: NonNullable<ProfileInput['household']> = {};
    for (const k of ['people_count', 'children', 'elderly'] as const) if (b.household[k] !== undefined) h[k] = b.household[k];
    if (b.household.pets?.length) {
      h.pets = b.household.pets.map((p, i) => {
        const kind = text(`household.pets.${i}.kind`, p.kind, 40) ?? '';
        return p.count !== undefined ? { kind, count: p.count } : { kind };
      });
    }
    if (h.people_count !== undefined && ((h.children ?? 0) > h.people_count || (h.elderly ?? 0) > h.people_count)) f.household = 'children/elderly cannot exceed people_count';
    if (Object.keys(h).length) out.household = h;
  }
  const addr = text('home_address', b.home_address, 300, true);
  if (addr) out.home_address = addr;
  if (b.emergency_contact) {
    const c = b.emergency_contact;
    const name = text('emergency_contact.name', c.name, 120), rel = text('emergency_contact.relationship', c.relationship, 60);
    const phone = c.phone?.trim();
    if (!phone || !PHONE_RE.test(phone)) f['emergency_contact.phone'] = 'must look like an E.164 phone number';
    if (name && rel && phone && PHONE_RE.test(phone)) out.emergency_contact = { name, phone, relationship: rel };
  }
  const notes = text('notes', b.notes, 1000, true);
  if (notes) out.notes = notes;
  if (Object.keys(f).length) throw invalid('Profile failed validation', f);
  return out;
}

export function splitProfile(p: ProfileInput): Sensitive {
  const s: Sensitive = {};
  for (const k of ['languages', 'phone', 'appearance', 'medical', 'mobility', 'household', 'home_address', 'emergency_contact', 'notes'] as const) {
    if (p[k] !== undefined) (s as Record<string, unknown>)[k] = p[k];
  }
  return s;
}

// ------------------------------------------------------------------------------------------ triage + LLM context

/** What triage may know. No name, phone, address, contacts. `conditions`/`medications` are free text typed by the user (sanitised before an LLM sees them). */
export interface ProfileTriageCtx {
  age_range?: AgeRange;
  flags: VulnerabilityFlag[];
  conditions: string[];
  medications: string[];
  mobility_needs: string[];
  household_people?: number;
}

export function triageCtxFromProfile(p: { birth_year: number | null; vuln_flags: string[] }, s: Sensitive | null, now = new Date()): ProfileTriageCtx {
  return {
    age_range: ageRangeOf(ageOf(p.birth_year, now)),
    flags: allFlags(p.vuln_flags, p.birth_year, now),
    conditions: s?.medical?.conditions ?? [],
    medications: s?.medical?.medications ?? [],
    mobility_needs: s?.mobility?.needs ?? [],
    household_people: s?.household?.people_count,
  };
}

export function triageCtxFromSummary(s: { age_range?: AgeRange; vulnerability_flags?: VulnerabilityFlag[] }): ProfileTriageCtx {
  return { age_range: s.age_range, flags: s.vulnerability_flags ?? [], conditions: [], medications: [], mobility_needs: [] };
}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\d{5,}/g, '#').replace(/\S+@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);

/** Compact structured object for the Nemotron prompt: coarse facts and clinical keywords only, sanitised and size-capped. */
export function llmProfileContext(c: ProfileTriageCtx) {
  const lim = (a: string[]) => a.slice(0, 8).map(clean).filter(Boolean);
  return {
    age_range: c.age_range ?? null,
    vulnerability_flags: c.flags,
    conditions: lim(c.conditions),
    medications: lim(c.medications),
    mobility_needs: c.mobility_needs.slice(0, 8),
  };
}

export const hasSignal = (c: ProfileTriageCtx | null | undefined): c is ProfileTriageCtx =>
  !!c && (c.flags.length > 0 || c.conditions.length > 0 || c.medications.length > 0 || c.mobility_needs.length > 0 || (c.household_people ?? 0) >= 5);

/** Modest, capped, explainable score contribution from the profile. Reasons only use coarse wording (they are visible to all dashboard users). */
export function profileScore(c: ProfileTriageCtx | null | undefined): { points: number; reasons: { text: string; weight: number }[] } {
  const reasons: { text: string; weight: number }[] = [];
  if (!c) return { points: 0, reasons };
  const f = new Set(c.flags);
  if (f.has('oxygen') || c.mobility_needs.includes('cannot_walk')) reasons.push({ text: f.has('oxygen') ? 'Vulnerability: oxygen dependent' : 'Vulnerability: cannot self-evacuate', weight: 10 });
  else if (f.has('mobility')) reasons.push({ text: 'Vulnerability: reduced mobility', weight: 4 });
  if (c.conditions.length || c.medications.length || f.has('medical')) reasons.push({ text: 'Vulnerability: medical condition on file', weight: 5 });
  if (f.has('child') || f.has('elderly')) reasons.push({ text: f.has('child') ? 'Vulnerability: young child' : 'Vulnerability: elderly', weight: 5 });
  if (f.has('sensory') || f.has('cognitive')) reasons.push({ text: 'Vulnerability: sensory or cognitive need', weight: 3 });
  if ((c.household_people ?? 0) >= 5) reasons.push({ text: 'Large household', weight: 3 });
  const points = Math.min(25, reasons.reduce((a, r) => a + r.weight, 0));
  return { points, reasons };
}
