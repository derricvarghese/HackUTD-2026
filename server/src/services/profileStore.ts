import { z } from 'zod';
import type { Ctx } from '../ctx';
import type { ProfileRow, SosRow } from '../db/types';
import { openProfile, profileKey } from '../crypto/profileCrypto';
import { AGE_RANGES, FLAG_ORDER, normalizeName, triageCtxFromProfile, triageCtxFromSummary, type ProfileSummary, type ProfileTriageCtx, type Sensitive } from '../domain/profile';
import { publicSourceFromRow, type ProfilePublicSource } from '../domain/privacy';

/** Shape of `MeshPayload.profile_summary`. Invalid summaries are dropped silently by callers (they must never reject an SOS). */
export const summarySchema = z.object({
  full_name: z.string().trim().min(1).max(120),
  age_range: z.enum(AGE_RANGES as [string, ...string[]]).optional(),
  vulnerability_flags: z.array(z.enum(FLAG_ORDER as [string, ...string[]])).max(8).optional(),
  profile_version: z.number().int().min(0),
});

export const parseSummary = (v: unknown): ProfileSummary | null => {
  const r = summarySchema.safeParse(v);
  return r.success ? ({ ...r.data, vulnerability_flags: r.data.vulnerability_flags ? [...new Set(r.data.vulnerability_flags)] : undefined } as ProfileSummary) : null;
};

export const getProfileRow = (ctx: Ctx, deviceId: string): Promise<ProfileRow | undefined> =>
  ctx.db.selectFrom('profiles').selectAll().where('device_id', '=', deviceId).executeTakeFirst();

/** Decrypts the sensitive part; null (and a content-free warning) when the key no longer matches. */
export function decryptSensitive(ctx: Ctx, row: ProfileRow): Sensitive | null {
  try { return openProfile<Sensitive>(profileKey(ctx.cfg), row.device_id, row.enc); }
  catch { ctx.log.warn({ device_id: row.device_id }, 'profile could not be decrypted (key changed?)'); return null; }
}

const PUBLIC_COLS = ['device_id', 'full_name', 'preferred_name', 'birth_year', 'vuln_flags', 'profile_version'] as const;

/** Public identity per case: the synced profile of the case's device wins, else the mesh summary carried by the case. Never reads `enc`. */
export async function publicSourcesFor(ctx: Ctx, rows: SosRow[]): Promise<Map<string, ProfilePublicSource>> {
  const out = new Map<string, ProfilePublicSource>();
  const devs = [...new Set(rows.map((r) => r.device_id).filter((x): x is string => !!x))];
  const profs = devs.length ? await ctx.db.selectFrom('profiles').select([...PUBLIC_COLS]).where('device_id', 'in', devs).execute() : [];
  const byDev = new Map(profs.map((p) => [p.device_id, p]));
  const now = new Date();
  for (const r of rows) {
    const p = r.device_id ? byDev.get(r.device_id) : undefined;
    if (p) { out.set(r.id, publicSourceFromRow(p, now)); continue; }
    const sum = parseSummary(r.profile_summary);
    if (sum) out.set(r.id, { source: 'mesh_summary', full_name: sum.full_name, age_range: sum.age_range, flags: (sum.vulnerability_flags ?? []) as ProfilePublicSource['flags'], profile_version: sum.profile_version });
  }
  return out;
}

/** Triage signals for one case: full synced profile if there is one, else whatever the mesh summary says. Never throws. */
export async function triageCtxFor(ctx: Ctx, c: { device_id: string | null; profile_summary: unknown }): Promise<ProfileTriageCtx | null> {
  try {
    if (c.device_id) {
      const row = await getProfileRow(ctx, c.device_id);
      if (row) return triageCtxFromProfile(row, decryptSensitive(ctx, row));
    }
    const sum = parseSummary(c.profile_summary);
    return sum ? triageCtxFromSummary({ age_range: sum.age_range, vulnerability_flags: sum.vulnerability_flags }) : null;
  } catch { return null; }
}

/** Normalised full names per case id (synced profile first, else mesh summary). Used only for the cheap exact-name dedupe bonus. */
export async function nameNormsFor(ctx: Ctx, rows: SosRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const devs = [...new Set(rows.map((r) => r.device_id).filter((x): x is string => !!x))];
  const profs = devs.length ? await ctx.db.selectFrom('profiles').select(['device_id', 'name_norm']).where('device_id', 'in', devs).execute() : [];
  const byDev = new Map(profs.map((p) => [p.device_id, p.name_norm]));
  for (const r of rows) {
    const n = (r.device_id && byDev.get(r.device_id)) || (parseSummary(r.profile_summary)?.full_name ? normalizeName(parseSummary(r.profile_summary)!.full_name) : '');
    if (n) out.set(r.id, n);
  }
  return out;
}
