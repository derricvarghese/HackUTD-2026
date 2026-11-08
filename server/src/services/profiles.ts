import { sql } from 'kysely';
import type { Ctx } from '../ctx';
import type { ProfileRow, SosRow } from '../db/types';
import { sealProfile, profileKey } from '../crypto/profileCrypto';
import { AppError, conflict, forbidden, invalid, notFound, tooMany } from '../errors';
import {
  normalizeName, splitProfile, staticFlags, validateProfileInput,
  type ProfileFullDto, type ProfileInput, type ProfilePublicDto,
} from '../domain/profile';
import { ACTIVE_ASSIGNMENT, canSeeFullProfile, publicSourceFromRow, toProfilePublic, toProfileView, type Viewer } from '../domain/privacy';
import { decryptSensitive, getProfileRow, triageCtxFor } from './profileStore';
import { persistTriage, rulesOutcome } from './triage';
import { broadcastSos } from './sosView';

const OPEN_STATUSES = ['reported', 'assigned', 'en_route', 'on_scene'] as const;

/** `If-Match` value: bare integer or quoted ("3"); undefined when absent. */
function parseIfMatch(h: string | undefined): number | undefined {
  if (h === undefined || h === '') return undefined;
  const m = /^"?([0-9]{1,9})"?$/.exec(h.trim());
  if (!m) throw invalid('If-Match must be the profile_version (integer)', { 'if-match': 'invalid' });
  return Number(m[1]);
}

export const etag = (v: number) => `"${v}"`;

export async function putProfile(ctx: Ctx, deviceId: string, callerId: string, body: ProfileInput, ifMatchHeader: string | undefined): Promise<{ profile: ProfileFullDto; created: boolean }> {
  if (callerId !== deviceId) throw forbidden('A device can only write its own profile');
  const rl = ctx.limiters.profile.take(deviceId);
  if (!rl.ok) throw tooMany(rl.retryAfterS);
  const now = new Date();
  const input = validateProfileInput(body, { consentVersion: ctx.cfg.PROFILE_CONSENT_VERSION, now });
  const ifMatch = parseIfMatch(ifMatchHeader);
  const sensitive = splitProfile(input);
  const enc = sealProfile(profileKey(ctx.cfg), deviceId, sensitive);
  const cols = {
    full_name: input.full_name, name_norm: normalizeName(input.full_name), preferred_name: input.preferred_name ?? null, birth_year: input.birth_year ?? null,
    vuln_flags: staticFlags(sensitive), enc, enc_version: 1, consent_version: input.consent.version, consent_accepted_at: new Date(input.consent.accepted_at),
  };
  const { row, created } = await ctx.db.transaction().execute(async (trx) => {
    const cur = await trx.selectFrom('profiles').select(['profile_version']).where('device_id', '=', deviceId).forUpdate().executeTakeFirst();
    const have = cur?.profile_version ?? 0;
    if (ifMatch !== undefined && ifMatch !== have) throw conflict('Profile version mismatch; fetch the current profile and retry', { profile_version: have });
    const synthetic = false;
    const r = cur
      ? await trx.updateTable('profiles').set({ ...cols, profile_version: have + 1, synthetic, updated_at: now }).where('device_id', '=', deviceId).returningAll().executeTakeFirstOrThrow()
      : await trx.insertInto('profiles').values({ device_id: deviceId, ...cols, profile_version: 1, synthetic, created_at: now, updated_at: now }).returningAll().executeTakeFirstOrThrow();
    // reconcile: the synced profile now supersedes any identity hint a mesh SOS carried
    await trx.updateTable('sos').set({ profile_summary: null }).where('device_id', '=', deviceId).where('profile_summary', 'is not', null).execute();
    return { row: r, created: !cur };
  });
  await onProfileChanged(ctx, deviceId, row);
  return { profile: toProfileView({ row, sensitive }, { kind: 'device', id: deviceId }, false, now) as ProfileFullDto, created };
}

/** Does this responder hold an ACTIVE assignment on a non-closed case of the device (or of a case merged with one of its cases)? */
export async function isActiveAssigneeForDevice(ctx: Ctx, responderId: string, deviceId: string): Promise<boolean> {
  const active = sql.join(ACTIVE_ASSIGNMENT.map((s) => sql.lit(s)));
  const r = await sql<{ ok: number }>`
    select 1 as ok from assignments a join sos s on s.id = a.sos_id
    where a.responder_id = ${responderId}::uuid and a.status in (${active}) and s.status <> 'closed'
      and (s.device_id = ${deviceId}::uuid or s.id in (select m.merged_into from sos m where m.device_id = ${deviceId}::uuid and m.merged_into is not null))
    limit 1`.execute(ctx.db);
  return r.rows.length > 0;
}

export async function getProfile(ctx: Ctx, deviceId: string, viewer: Viewer): Promise<ProfileFullDto | ProfilePublicDto> {
  if (viewer.kind === 'anon') throw forbidden();
  if (viewer.kind === 'device' && viewer.id !== deviceId) throw forbidden('A device can only read its own profile');
  const row = await getProfileRow(ctx, deviceId);
  if (!row) throw notFound('No profile for this device');
  const assignee = viewer.kind === 'responder' && viewer.role !== 'admin' ? await isActiveAssigneeForDevice(ctx, viewer.id, deviceId) : false;
  const sensitive = canSeeFullProfile(viewer, deviceId, assignee) ? decryptSensitive(ctx, row) : null;
  if (canSeeFullProfile(viewer, deviceId, assignee) && !sensitive) throw new AppError(500, 'internal', 'Profile cannot be read right now');
  return toProfileView({ row, sensitive }, viewer, assignee);
}

export async function deleteProfile(ctx: Ctx, deviceId: string, viewer: Viewer) {
  const admin = viewer.kind === 'responder' && viewer.role === 'admin';
  if (!admin && !(viewer.kind === 'device' && viewer.id === deviceId)) throw forbidden('Only the device itself or an admin can delete a profile');
  const r = await ctx.db.deleteFrom('profiles').where('device_id', '=', deviceId).returning('device_id').executeTakeFirst();
  if (!r) throw notFound('No profile for this device');
  await ctx.db.updateTable('sos').set({ profile_summary: null }).where('device_id', '=', deviceId).where('profile_summary', 'is not', null).execute();
  await onProfileChanged(ctx, deviceId, null);
}

/**
 * Called after a profile was written or erased: re-triage the device's open cases (rules immediately, provisional again; the AI pass follows in the background),
 * push `sos.updated` per case and one `profile.updated` frame (public fields only).
 */
export async function onProfileChanged(ctx: Ctx, deviceId: string, row: ProfileRow | null) {
  const cases = await openCasesOf(ctx, deviceId);
  if (!cases.length) return;
  for (const c of cases) {
    const pctx = await triageCtxFor(ctx, c);
    await persistTriage(ctx, c.id, rulesOutcome(c, pctx), { kind: 'system' });
    await broadcastSos(ctx, 'sos.updated', c.id); // provisional again; persistTriage queued the AI pass
    void ctx.agent.trigger(c.id, 'case_edit');
  }
  if (row) {
    const frame = { ...toProfilePublic(publicSourceFromRow(row)), device_id: deviceId, sos_ids: cases.map((c) => c.id) };
    ctx.hub.publish('profile.updated', () => frame);
  }
}

export const openCasesOf = (ctx: Ctx, deviceId: string): Promise<SosRow[]> =>
  ctx.db.selectFrom('sos').selectAll().where('device_id', '=', deviceId).where('status', 'in', [...OPEN_STATUSES]).execute();

/** Deletes profiles of the given devices that no longer have any case linked (erasure paths: case delete, event purge/delete). */
export async function dropOrphanedProfiles(ctx: Ctx | { db: Ctx['db'] }, deviceIds: string[]): Promise<number> {
  const ids = [...new Set(deviceIds)];
  if (!ids.length) return 0;
  const r = await ctx.db.deleteFrom('profiles').where('device_id', 'in', ids)
    .where((eb) => eb.not(eb.exists(eb.selectFrom('sos').select('id').whereRef('sos.device_id', '=', 'profiles.device_id')))).returning('device_id').execute();
  return r.length;
}

/**
 * Retention for profiles nobody references: no case linked, profile not updated AND device not seen for PROFILE_RETENTION_DAYS.
 * (A device with cases keeps its profile until those cases are purged/erased.)
 */
export async function purgeStaleProfiles(ctx: Ctx, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ctx.cfg.PROFILE_RETENTION_DAYS * 86400_000);
  const r = await ctx.db.deleteFrom('profiles').where('updated_at', '<', cutoff)
    .where((eb) => eb.not(eb.exists(eb.selectFrom('sos').select('id').whereRef('sos.device_id', '=', 'profiles.device_id'))))
    .where((eb) => eb.not(eb.exists(eb.selectFrom('devices').select('id').whereRef('devices.id', '=', 'profiles.device_id').where('devices.last_seen_at', '>=', cutoff))))
    .returning('device_id').execute();
  return r.length;
}
