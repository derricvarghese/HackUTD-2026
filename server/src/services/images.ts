import { randomUUID } from 'node:crypto';
import type { Ctx } from '../ctx';
import type { components } from '../generated/api';
import type { CaseImageRow, SosRow } from '../db/types';
import { cleanImage, ImageError, IMAGE_MIMES, syntheticImage } from '../domain/image';
import { AppError, conflict, forbidden, invalid, notFound, tooMany } from '../errors';
import { addEvent, broadcastSos, getRowOrThrow } from './sosView';

export type CaseImage = components['schemas']['CaseImage'];

/** Who is calling: a signed device or a logged-in responder (names are only used for display on uploads). */
export type ImageActor = { kind: 'device'; id: string } | { kind: 'responder'; id: string; role: 'responder' | 'volunteer' | 'admin' };

export const MAX_CAPTION = 200;

type MetaRow = Omit<CaseImageRow, 'data'> & { responder_name: string | null };
const META_COLS = ['case_images.id', 'case_images.sos_id', 'case_images.device_id', 'case_images.uploaded_by_kind', 'case_images.responder_id', 'case_images.content_type', 'case_images.bytes', 'case_images.width', 'case_images.height', 'case_images.caption', 'case_images.created_at'] as const;

export function toImageDto(r: MetaRow): CaseImage {
  return {
    id: r.id, content_type: r.content_type, bytes: r.bytes, width: r.width, height: r.height, caption: r.caption,
    uploaded_by: r.uploaded_by_kind === 'responder' ? { kind: 'responder', ...(r.responder_name ? { responder_name: r.responder_name } : {}) } : { kind: 'device' },
    created_at: r.created_at.toISOString(),
  };
}

async function isActiveAssigneeOf(ctx: Ctx, row: SosRow, responderId: string): Promise<boolean> {
  const ids = row.merged_into ? [row.id, row.merged_into] : [row.id];
  const a = await ctx.db.selectFrom('assignments').select('id').where('sos_id', 'in', ids).where('responder_id', '=', responderId).where('status', 'in', ['assigned', 'en_route', 'on_scene']).executeTakeFirst();
  return !!a;
}

/** Same rule as exact location / the full profile: admin or the ACTIVE assignee of the case (or of the primary it was merged into). */
async function responderEntitled(ctx: Ctx, row: SosRow, actor: Extract<ImageActor, { kind: 'responder' }>) {
  return actor.role === 'admin' || (await isActiveAssigneeOf(ctx, row, actor.id));
}

/** Throws 403 unless the actor may read the case's photos. Returns the `device_id` filter to apply (device owners see only photos of their own device). */
async function assertReader(ctx: Ctx, row: SosRow, actor: ImageActor): Promise<{ onlyDevice: string | null }> {
  if (actor.kind === 'device') {
    if (actor.id !== row.device_id) throw forbidden('Photos are visible to the sending phone, the assigned responder and admins only');
    return { onlyDevice: actor.id };
  }
  if (!(await responderEntitled(ctx, row, actor))) throw forbidden('Photos are visible to the sending phone, the assigned responder and admins only');
  return { onlyDevice: null };
}

/** The case plus the duplicates merged into it: a primary shows its duplicates' photos too. */
const groupIds = (ctx: Ctx, sosId: string) =>
  ctx.db.selectFrom('sos').select('id').where('merged_into', '=', sosId).execute().then((r) => [sosId, ...r.map((x) => x.id)]);

function metaQuery(ctx: Ctx) {
  return ctx.db.selectFrom('case_images').leftJoin('responders', 'responders.id', 'case_images.responder_id')
    .select([...META_COLS, 'responders.name as responder_name']);
}

/** Photo counts for a page of cases (a primary also counts the photos of its merged duplicates). Public: a number only. */
export async function imageCountsFor(ctx: Ctx, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const { rows } = await ctx.pool.query<{ root: string; n: string }>(
    `select t.root, count(*) n from case_images ci join sos s on s.id = ci.sos_id
       cross join lateral (values (s.id), (s.merged_into)) as t(root)
      where t.root = any($1::uuid[]) group by t.root`, [ids]);
  return new Map(rows.map((r) => [r.root, Number(r.n)]));
}

const mimeOf = (contentType: string | undefined) => (contentType ?? '').split(';')[0].trim().toLowerCase();

async function touch(ctx: Ctx, row: SosRow) {
  const now = new Date();
  const ids = row.merged_into ? [row.id, row.merged_into] : [row.id];
  await ctx.db.updateTable('sos').set((eb) => ({ version: eb('version', '+', 1), updated_at: now })).where('id', 'in', ids).execute();
  for (const id of ids) await broadcastSos(ctx, 'sos.updated', id); // public fields only (image_count); never bytes, ids or captions
}

/** PUT /sos/{sosId}/images/{imageId}. Returns created=false for an idempotent replay of the same id. */
export async function putImage(ctx: Ctx, sosId: string, imageId: string, actor: ImageActor, contentType: string | undefined, body: unknown, caption: string | undefined): Promise<{ image: CaseImage; created: boolean }> {
  const rl = ctx.limiters.image.take(`${actor.kind}:${actor.id}`);
  if (!rl.ok) throw tooMany(rl.retryAfterS);
  const row = await getRowOrThrow(ctx, sosId);
  if (actor.kind === 'device') {
    if (actor.id !== row.device_id) throw forbidden('Only the phone that sent this case can attach photos');
  } else if (!(await responderEntitled(ctx, row, actor))) throw forbidden('Only an admin or the responder assigned to this case can attach photos');

  const existing = await metaQuery(ctx).where('case_images.id', '=', imageId).executeTakeFirst();
  if (existing) {
    if (existing.sos_id !== sosId) throw conflict('This image id is already used');
    return { image: toImageDto(existing), created: false };
  }

  const mt = mimeOf(contentType);
  if (!(IMAGE_MIMES as readonly string[]).includes(mt)) throw new AppError(415, 'validation_failed', 'Only image/jpeg and image/png are accepted');
  if (!Buffer.isBuffer(body) || !body.length) throw invalid('Empty image body', { body: 'required' });
  if (body.length > ctx.cfg.IMAGE_MAX_BYTES) throw new AppError(413, 'validation_failed', `Image larger than ${Math.round(ctx.cfg.IMAGE_MAX_BYTES / 1024 / 1024)} MB`);
  let clean;
  try { clean = cleanImage(body, mt); } catch (e) {
    if (e instanceof ImageError) throw invalid(`Not a valid ${mt === 'image/png' ? 'PNG' : 'JPEG'} image: ${e.message}`, { body: 'invalid image' });
    throw e;
  }
  const cap = caption?.trim().slice(0, MAX_CAPTION) || null;

  const inserted = await ctx.db.transaction().execute(async (trx) => {
    await trx.selectFrom('sos').select('id').where('id', '=', sosId).forUpdate().executeTakeFirst(); // serialises the per-case limit
    const n = await trx.selectFrom('case_images').select((eb) => eb.fn.countAll<string>().as('n')).where('sos_id', '=', sosId).executeTakeFirstOrThrow();
    const dup = await trx.selectFrom('case_images').select('id').where('id', '=', imageId).executeTakeFirst();
    if (dup) return false;
    if (Number(n.n) >= ctx.cfg.IMAGE_MAX_PER_CASE) throw conflict(`A case can have at most ${ctx.cfg.IMAGE_MAX_PER_CASE} photos`, { max: ctx.cfg.IMAGE_MAX_PER_CASE });
    await trx.insertInto('case_images').values({
      id: imageId, sos_id: sosId, device_id: row.device_id, uploaded_by_kind: actor.kind, responder_id: actor.kind === 'responder' ? actor.id : null,
      content_type: mt as 'image/jpeg' | 'image/png', bytes: clean.data.length, width: clean.width, height: clean.height, caption: cap, data: clean.data,
    }).execute();
    await addEvent(trx, sosId, 'edited', actor.kind === 'device' ? { kind: 'victim', id: actor.id } : { kind: 'responder', id: actor.id }, { image_added: true });
    return true;
  });
  const meta = await metaQuery(ctx).where('case_images.id', '=', imageId).executeTakeFirstOrThrow();
  if (inserted) await touch(ctx, row);
  return { image: toImageDto(meta), created: inserted };
}

export async function listImages(ctx: Ctx, sosId: string, actor: ImageActor): Promise<CaseImage[]> {
  const row = await getRowOrThrow(ctx, sosId);
  const { onlyDevice } = await assertReader(ctx, row, actor);
  return listFor(ctx, sosId, onlyDevice);
}

async function listFor(ctx: Ctx, sosId: string, onlyDevice: string | null): Promise<CaseImage[]> {
  let qb = metaQuery(ctx).where('case_images.sos_id', 'in', await groupIds(ctx, sosId));
  if (onlyDevice) qb = qb.where('case_images.device_id', '=', onlyDevice);
  return (await qb.orderBy('case_images.created_at').orderBy('case_images.id').execute()).map(toImageDto);
}

/** For SosDetail: the caller has already established the viewer is entitled (admin / active assignee). */
export const listImagesEntitled = (ctx: Ctx, sosId: string) => listFor(ctx, sosId, null);

export async function getImageBytes(ctx: Ctx, sosId: string, imageId: string, actor: ImageActor): Promise<{ mime: string; data: Buffer }> {
  const row = await getRowOrThrow(ctx, sosId);
  const { onlyDevice } = await assertReader(ctx, row, actor);
  let qb = ctx.db.selectFrom('case_images').select(['content_type', 'data']).where('id', '=', imageId).where('sos_id', 'in', await groupIds(ctx, sosId));
  if (onlyDevice) qb = qb.where('device_id', '=', onlyDevice);
  const r = await qb.executeTakeFirst();
  if (!r) throw notFound('Image not found');
  return { mime: r.content_type, data: r.data };
}

/** The uploader, the owning device or an admin may delete. */
export async function deleteImage(ctx: Ctx, sosId: string, imageId: string, actor: ImageActor) {
  const row = await getRowOrThrow(ctx, sosId);
  const img = await ctx.db.selectFrom('case_images').select(['id', 'sos_id', 'device_id', 'responder_id']).where('id', '=', imageId).where('sos_id', 'in', await groupIds(ctx, sosId)).executeTakeFirst();
  if (!img) throw notFound('Image not found');
  const allowed = actor.kind === 'device' ? actor.id === img.device_id : actor.role === 'admin' || actor.id === img.responder_id;
  if (!allowed) throw forbidden('Only the uploader, the phone that owns the case or an admin can delete a photo');
  await ctx.db.deleteFrom('case_images').where('id', '=', imageId).execute();
  const owner = img.sos_id === row.id ? row : await getRowOrThrow(ctx, img.sos_id);
  await addEvent(ctx.db, img.sos_id, 'edited', actor.kind === 'device' ? { kind: 'victim', id: actor.id } : { kind: 'responder', id: actor.id }, { image_removed: true });
  await touch(ctx, owner);
}

/** Demo data: a few tiny synthetic placeholder photos on a seeded case. */
export async function seedDemoImages(ctx: Ctx, sosId: string, deviceId: string | null, n: number) {
  for (let k = 0; k < n; k++) {
    const img = syntheticImage(Math.floor(Math.random() * 3));
    await ctx.db.insertInto('case_images').values({
      id: randomUUID(), sos_id: sosId, device_id: deviceId, uploaded_by_kind: 'device', content_type: img.mime, bytes: img.data.length,
      width: img.width, height: img.height, caption: 'Synthetic demo image', data: img.data,
    }).execute();
  }
}
