import type { Ctx } from '../ctx';
import { AppError, forbidden, invalid, notFound } from '../errors';
import { addEvent, broadcastSos, getRowOrThrow } from './sosView';

export const VOICE_MIMES = ['audio/ogg', 'audio/mp4', 'audio/webm'] as const;
export type VoiceMime = (typeof VOICE_MIMES)[number];

/** Cheap container sniffing so a mislabelled upload (an executable, HTML...) is refused. */
export function sniffAudio(buf: Buffer, mime: string): boolean {
  if (mime === 'audio/ogg') return buf.subarray(0, 4).toString('latin1') === 'OggS';
  if (mime === 'audio/webm') return buf.length > 4 && buf.readUInt32BE(0) === 0x1a45dfa3;
  if (mime === 'audio/mp4') return buf.length > 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp';
  return false;
}

/** Stored in Postgres (bytea): at most 2 MB per case, purged with the case/event. The owner device or the gateway that uploaded the SOS may upload. */
export async function putVoiceNote(ctx: Ctx, sosId: string, deviceId: string, mime: string, body: unknown) {
  const sos = await getRowOrThrow(ctx, sosId);
  if (sos.device_id !== deviceId && sos.gateway_device_id !== deviceId) throw forbidden('Only the sending phone or its gateway can attach audio');
  const mt = (mime ?? '').split(';')[0].trim().toLowerCase();
  if (!(VOICE_MIMES as readonly string[]).includes(mt)) throw new AppError(415, 'validation_failed', 'Unsupported audio type');
  if (!Buffer.isBuffer(body) || !body.length) throw invalid('Empty audio body', { body: 'required' });
  if (body.length > ctx.cfg.VOICE_MAX_BYTES) throw new AppError(413, 'validation_failed', 'Voice note larger than 2 MB');
  if (!sniffAudio(body, mt)) throw invalid('File content does not match its audio type', { body: `not a valid ${mt} file` });
  const now = new Date();
  await ctx.db.insertInto('voice_notes').values({ sos_id: sosId, mime: mt, size_bytes: body.length, data: body })
    .onConflict((oc) => oc.column('sos_id').doUpdateSet({ mime: mt, size_bytes: body.length, data: body, updated_at: now })).execute();
  await ctx.db.updateTable('sos').set((eb) => ({ has_voice_note: true, version: eb('version', '+', 1), updated_at: now })).where('id', '=', sosId).execute();
  await addEvent(ctx.db, sosId, 'edited', { kind: 'victim', id: deviceId }, { voice_note: true, size_bytes: body.length });
  await broadcastSos(ctx, 'sos.updated', sosId);
}

async function assertListener(ctx: Ctx, sosId: string, who: { id: string; role: string }) {
  await getRowOrThrow(ctx, sosId);
  if (who.role === 'admin') return;
  const a = await ctx.db.selectFrom('assignments').select('id').where('sos_id', '=', sosId).where('responder_id', '=', who.id).where('status', 'in', ['assigned', 'en_route', 'on_scene']).executeTakeFirst();
  if (!a) throw forbidden('Voice notes are visible to the assigned responder and admins only');
}

export async function getVoiceNote(ctx: Ctx, sosId: string, who: { id: string; role: string }) {
  await assertListener(ctx, sosId, who);
  const v = await ctx.db.selectFrom('voice_notes').select(['mime', 'data']).where('sos_id', '=', sosId).executeTakeFirst();
  if (!v?.data) throw notFound('No voice note for this case');
  return { mime: v.mime, data: v.data };
}

export async function deleteVoiceNote(ctx: Ctx, sosId: string, who: { id: string; role: string }) {
  await assertListener(ctx, sosId, who);
  const r = await ctx.db.deleteFrom('voice_notes').where('sos_id', '=', sosId).returning('id').executeTakeFirst();
  if (!r) throw notFound('No voice note for this case');
  await ctx.db.updateTable('sos').set((eb) => ({ has_voice_note: false, version: eb('version', '+', 1), updated_at: new Date() })).where('id', '=', sosId).execute();
  await broadcastSos(ctx, 'sos.updated', sosId);
}
