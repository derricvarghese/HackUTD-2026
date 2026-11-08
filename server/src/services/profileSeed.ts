import type { Ctx } from '../ctx';
import { profileKey, sealProfile } from '../crypto/profileCrypto';
import { ageOf, ageRangeOf, allFlags, normalizeName, splitProfile, staticFlags, type ProfileInput, type ProfileSummary } from '../domain/profile';

const FIRST = ['Alex', 'Sam', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Avery', 'Maria', 'Luis', 'Priya', 'Wei', 'Amara', 'Noah', 'Grace', 'Omar'];
const LAST = ['Demo', 'Sample', 'Testwell', 'Placeholder', 'Example', 'Mock', 'Synth', 'Fakename'];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

/** Fabricated identity for demo data. Clearly synthetic: the last name is a placeholder word and the row/case is flagged `synthetic`. */
export function fakeProfile(now = new Date()): ProfileInput {
  const full_name = `${pick(FIRST)} ${pick(LAST)}`;
  const age = [6, 9, 24, 31, 42, 57, 68, 74, 83][Math.floor(Math.random() * 9)];
  const p: ProfileInput = {
    full_name, birth_year: now.getUTCFullYear() - age, languages: ['en'],
    consent: { accepted: true, version: 'synthetic', accepted_at: now.toISOString() },
    household: { people_count: 1 + Math.floor(Math.random() * 5) },
  };
  const r = Math.random();
  if (r < 0.25) { p.mobility = { needs: [pick(['wheelchair', 'cannot_walk', 'walks_with_aid'] as const)] }; }
  else if (r < 0.4) { p.mobility = { needs: ['oxygen_dependent'] }; p.medical = { conditions: ['COPD (synthetic)'] }; }
  else if (r < 0.6) { p.medical = { conditions: ['type 2 diabetes (synthetic)'], medications: ['insulin (synthetic)'], blood_type: pick(['O+', 'A+', 'B-', 'unknown'] as const) }; }
  else if (r < 0.7) { p.mobility = { needs: [pick(['vision_impaired', 'hearing_impaired', 'cognitive'] as const)] }; }
  return p;
}

export function summaryOf(p: ProfileInput, now = new Date()): ProfileSummary {
  const flags = allFlags(staticFlags(splitProfile(p)), p.birth_year ?? null, now);
  return { full_name: p.full_name, age_range: ageRangeOf(ageOf(p.birth_year ?? null, now)), vulnerability_flags: flags, profile_version: 0 };
}

export async function insertSyntheticProfile(ctx: Ctx, deviceId: string, p = fakeProfile()): Promise<void> {
  const s = splitProfile(p);
  await ctx.db.insertInto('profiles').values({
    device_id: deviceId, full_name: p.full_name, name_norm: normalizeName(p.full_name), birth_year: p.birth_year ?? null, vuln_flags: staticFlags(s),
    enc: sealProfile(profileKey(ctx.cfg), deviceId, s), consent_version: 'synthetic', consent_accepted_at: new Date(), synthetic: true,
  }).onConflict((oc) => oc.column('device_id').doNothing()).execute();
}
