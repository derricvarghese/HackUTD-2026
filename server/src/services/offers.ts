import { sql } from 'kysely';
import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import type { OfferMatchRow, OfferRow, SosRow } from '../db/types';
import { decodeCursor, encodeCursor, keysetWhere, orderSql, type SortKey } from '../db/cursor';
import { approxCell, bboxAround, haversineM } from '../domain/geo';
import { matchOffer } from '../domain/matching';
import { conflict, forbidden, invalid, notFound } from '../errors';
import { activeEventRow } from './events';
import { senderHash } from './devices';

export type Offer = components['schemas']['Offer'];
export type OfferMatch = components['schemas']['OfferMatch'];
type Create = Omit<components['schemas']['OfferCreate'], 'radius_km'> & { radius_km?: number };
type Update = components['schemas']['OfferUpdate'];
export type OfferActor = { kind: 'device'; id: string } | { kind: 'responder'; id: string; role: 'responder' | 'volunteer' | 'admin' };

const matchDto = (m: OfferMatchRow): OfferMatch => ({
  id: m.id, offer_id: m.offer_id, sos_id: m.sos_id, status: m.status, distance_km: m.distance_km, ...(m.score != null ? { score: m.score } : {}), created_at: m.created_at.toISOString(),
});

export async function toOffers(ctx: Ctx, rows: OfferRow[]): Promise<Offer[]> {
  if (!rows.length) return [];
  const counts = await ctx.db.selectFrom('offer_matches').select(['offer_id', (eb) => eb.fn.countAll<number>().as('n')]).where('offer_id', 'in', rows.map((r) => r.id)).groupBy('offer_id').execute();
  const m = new Map(counts.map((c) => [c.offer_id, Number(c.n)]));
  return rows.map((o) => ({
    id: o.id, sender_hash: o.sender_hash, kind: o.kind as Offer['kind'], ...(o.description != null ? { description: o.description } : {}), capacity: o.capacity,
    status: o.status, approx_location: { lat: o.approx_lat, lng: o.approx_lng, radius_m: 1000 }, radius_km: o.radius_km, match_count: m.get(o.id) ?? 0,
    expires_at: o.expires_at ? o.expires_at.toISOString() : null, created_at: o.created_at.toISOString(),
  }));
}

async function row(ctx: Ctx, id: string): Promise<OfferRow> {
  const o = await ctx.db.selectFrom('offers').selectAll().where('id', '=', id).executeTakeFirst();
  if (!o) throw notFound('Offer not found');
  return o;
}
const isStaff = (a: OfferActor) => a.kind === 'responder' && a.role !== 'volunteer';
function assertOwnerOrStaff(o: OfferRow, a: OfferActor) {
  if (a.kind === 'device' ? o.device_id !== a.id : !isStaff(a)) throw forbidden('Only the offerer or a responder can do this');
}

/** `id` lets a mesh `kind=offer` envelope use its envelope id (idempotent). */
export async function createOffer(ctx: Ctx, b: Create, deviceId: string, id?: string): Promise<{ offer: Offer; created: boolean }> {
  if (id) { const ex = await ctx.db.selectFrom('offers').selectAll().where('id', '=', id).executeTakeFirst(); if (ex) return { offer: (await toOffers(ctx, [ex]))[0], created: false }; }
  if (b.lat < -90 || b.lat > 90 || b.lng < -180 || b.lng > 180) throw invalid('lat/lng out of range', { lat: 'out of range' });
  const dev = await ctx.db.selectFrom('devices').select(['sender_hash']).where('id', '=', deviceId).executeTakeFirst();
  const ev = await activeEventRow(ctx);
  const a = approxCell(b.lat, b.lng);
  const o = await ctx.db.insertInto('offers').values({
    ...(id ? { id } : {}), event_id: ev?.id ?? null, device_id: deviceId, sender_hash: dev?.sender_hash ?? senderHash(ctx, deviceId), kind: b.kind, description: b.description ?? null,
    capacity: b.capacity ?? null, lat: b.lat, lng: b.lng, approx_lat: a.lat, approx_lng: a.lng, radius_km: b.radius_km ?? 3, expires_at: b.expires_at ? new Date(b.expires_at) : null,
  }).onConflict((oc) => oc.column('id').doNothing()).returningAll().executeTakeFirst();
  if (!o) return { offer: (await toOffers(ctx, [await row(ctx, id!)]))[0], created: false };
  await matchOfferToCases(ctx, o);
  const dto = (await toOffers(ctx, [o]))[0];
  ctx.hub.publish('offer.created', () => dto);
  return { offer: dto, created: true };
}

const KEYS: SortKey[] = [{ expr: 'offers.created_at', dir: 'desc', cast: 'timestamptz' }, { expr: 'offers.id', dir: 'desc', cast: 'uuid' }];
export async function listOffers(ctx: Ctx, q: { limit: number; cursor?: string; kind?: string; status?: string; near?: string; radius_km?: number; mine?: boolean }, actor: OfferActor) {
  let qb = ctx.db.selectFrom('offers').selectAll();
  if (q.kind) qb = qb.where('kind', '=', q.kind);
  if (q.status) qb = qb.where('status', '=', q.status as OfferRow['status']);
  if (q.mine) {
    if (actor.kind !== 'device') throw invalid('mine=true needs a device caller', { mine: 'device only' });
    qb = qb.where('device_id', '=', actor.id);
  }
  if (q.near) {
    const p = q.near.split(',').map(Number);
    if (p.length !== 2 || p.some((n) => !Number.isFinite(n))) throw invalid('near must be lat,lng', { near: 'invalid' });
    const r = q.radius_km ?? 5;
    qb = qb.where(sql<boolean>`6371.0088 * 2 * asin(sqrt(power(sin(radians(approx_lat - ${p[0]}) / 2), 2) + cos(radians(${p[0]})) * cos(radians(approx_lat)) * power(sin(radians(approx_lng - ${p[1]}) / 2), 2))) <= ${r}`);
  }
  if (q.cursor) qb = qb.where(keysetWhere(KEYS, decodeCursor(q.cursor, 'offers', KEYS.length)));
  const rows = await qb.orderBy(orderSql(KEYS)).limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: await toOffers(ctx, page),
    next_cursor: rows.length > q.limit && last ? encodeCursor('offers', [last.created_at.toISOString(), last.id]) : null,
  };
}

export async function getOffer(ctx: Ctx, id: string): Promise<Offer> { return (await toOffers(ctx, [await row(ctx, id)]))[0]; }

export async function updateOffer(ctx: Ctx, id: string, b: Update, actor: OfferActor): Promise<Offer> {
  const cur = await row(ctx, id);
  assertOwnerOrStaff(cur, actor);
  const patch: Partial<OfferRow> = { updated_at: new Date() };
  if (b.description !== undefined) patch.description = b.description;
  if (b.capacity !== undefined) patch.capacity = b.capacity;
  if (b.radius_km !== undefined) patch.radius_km = b.radius_km;
  if (b.status !== undefined) patch.status = b.status;
  const moved = b.lat !== undefined || b.lng !== undefined;
  if (moved) {
    const lat = b.lat ?? cur.lat, lng = b.lng ?? cur.lng;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw invalid('lat/lng out of range', { lat: 'out of range' });
    const a = approxCell(lat, lng);
    Object.assign(patch, { lat, lng, approx_lat: a.lat, approx_lng: a.lng });
  }
  const o = await ctx.db.updateTable('offers').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  if ((moved || b.radius_km !== undefined || b.capacity !== undefined) && (o.status === 'open' || o.status === 'matched')) await matchOfferToCases(ctx, o);
  return (await toOffers(ctx, [o]))[0];
}

export async function deleteOffer(ctx: Ctx, id: string, actor: OfferActor) {
  assertOwnerOrStaff(await row(ctx, id), actor);
  await ctx.db.deleteFrom('offers').where('id', '=', id).execute();
}

// ----------------------------------------------------------------------------------------- matching

async function suggest(ctx: Ctx, offer: OfferRow, sosId: string, r: { distance_km: number; score: number }) {
  const m = await ctx.db.insertInto('offer_matches').values({ offer_id: offer.id, sos_id: sosId, distance_km: r.distance_km, score: r.score })
    .onConflict((oc) => oc.columns(['offer_id', 'sos_id']).doNothing()).returningAll().executeTakeFirst();
  if (!m) return null;
  const dto = matchDto(m);
  ctx.hub.publish('offer.matched', () => dto);
  ctx.log.info({ offer_id: offer.id, match_id: m.id }, 'offer matched (offerer notified via push when a token is known)');
  return m;
}

/** New / moved offer: suggest the best nearby open cases (top 10). */
export async function matchOfferToCases(ctx: Ctx, offer: OfferRow): Promise<OfferMatchRow[]> {
  if (offer.status !== 'open' && offer.status !== 'matched') return [];
  const box = bboxAround(offer.lat, offer.lng, offer.radius_km * 1000);
  const cases = await ctx.db.selectFrom('sos').selectAll()
    .where('status', 'not in', ['resolved', 'closed', 'merged']).where('lat', '>=', box.minLat).where('lat', '<=', box.maxLat).where('lng', '>=', box.minLng).where('lng', '<=', box.maxLng).limit(500).execute();
  const hits = cases.map((s) => ({ s, r: matchOffer(offer, { ...s, score: s.score_override ?? s.score }) })).filter((x) => x.r).sort((a, b) => b.r!.score - a.r!.score).slice(0, 10);
  const out: OfferMatchRow[] = [];
  for (const h of hits) { const m = await suggest(ctx, offer, h.s.id, h.r!); if (m) out.push(m); }
  return out;
}

/** New case: suggest every open offer that can reach it. */
export async function matchSosToOffers(ctx: Ctx, sosId: string): Promise<void> {
  const s = await ctx.db.selectFrom('sos').selectAll().where('id', '=', sosId).executeTakeFirst();
  if (!s || s.lat == null || s.status === 'merged') return;
  const offers = await ctx.db.selectFrom('offers').selectAll().where('status', 'in', ['open', 'matched']).limit(1000).execute();
  for (const o of offers) {
    const r = matchOffer(o, { ...s, score: s.score_override ?? s.score });
    if (r) await suggest(ctx, o, s.id, r);
  }
}

export async function matchesForSos(ctx: Ctx, sosId: string): Promise<OfferMatch[]> {
  const rows = await ctx.db.selectFrom('offer_matches').selectAll().where('sos_id', '=', sosId).orderBy('created_at').execute();
  return rows.map(matchDto);
}

// ----------------------------------------------------------------------------------------- /offers/{id}/matches

export async function listMatches(ctx: Ctx, offerId: string, actor: OfferActor): Promise<OfferMatch[]> {
  const o = await row(ctx, offerId);
  if (actor.kind === 'device' && o.device_id !== actor.id) throw forbidden('Not your offer');
  const rows = await ctx.db.selectFrom('offer_matches').selectAll().where('offer_id', '=', offerId).orderBy('created_at').execute();
  return rows.map(matchDto);
}

export async function createMatch(ctx: Ctx, offerId: string, sosId: string, actor: OfferActor): Promise<OfferMatch> {
  if (!isStaff(actor)) throw forbidden('Only responders can match offers manually');
  const o = await row(ctx, offerId);
  const s = await ctx.db.selectFrom('sos').selectAll().where('id', '=', sosId).executeTakeFirst();
  if (!s) throw notFound('Case not found');
  const dup = await ctx.db.selectFrom('offer_matches').select('id').where('offer_id', '=', offerId).where('sos_id', '=', sosId).executeTakeFirst();
  if (dup) throw conflict('This offer is already matched to that case', { match_id: dup.id });
  const r = { distance_km: s.lat != null && s.lng != null ? Math.round(haversineM(o.lat, o.lng, s.lat, s.lng) / 10) / 100 : 0, score: 0 };
  const m = await ctx.db.insertInto('offer_matches').values({ offer_id: offerId, sos_id: sosId, distance_km: r.distance_km, score: r.score }).returningAll().executeTakeFirstOrThrow();
  const dto = matchDto(m);
  ctx.hub.publish('offer.matched', () => dto);
  return dto;
}

export async function updateMatch(ctx: Ctx, offerId: string, matchId: string, status: 'accepted' | 'declined' | 'completed', actor: OfferActor): Promise<OfferMatch> {
  const o = await row(ctx, offerId);
  assertOwnerOrStaff(o, actor);
  const m = await ctx.db.updateTable('offer_matches').set({ status, updated_at: new Date() }).where('id', '=', matchId).where('offer_id', '=', offerId).returningAll().executeTakeFirst();
  if (!m) throw notFound('Match not found');
  if (status === 'accepted' && o.status === 'open') await ctx.db.updateTable('offers').set({ status: 'matched', updated_at: new Date() }).where('id', '=', offerId).execute();
  if (status === 'completed') await ctx.db.updateTable('offers').set({ status: 'completed', updated_at: new Date() }).where('id', '=', offerId).execute();
  const dto = matchDto(m);
  ctx.hub.publish('offer.matched', () => dto);
  return dto;
}

export async function deleteMatch(ctx: Ctx, offerId: string, matchId: string, actor: OfferActor) {
  if (!isStaff(actor)) throw forbidden('Only responders can remove matches');
  const r = await ctx.db.deleteFrom('offer_matches').where('id', '=', matchId).where('offer_id', '=', offerId).returning('id').executeTakeFirst();
  if (!r) throw notFound('Match not found');
}

export type { SosRow };
