import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import type { EventRow, FacilityRow } from '../db/types';
import { extHttp, TtlCache } from './net';
import { notFound } from '../errors';

export type FacilityDto = components['schemas']['Facility'];
type Kind = FacilityRow['kind'];

export interface FacilitiesService {
  /** Starts the background ingestion for an event (new event, changed geofence). Never blocks, never throws. */
  schedule(eventId: string): void;
  /** One ingestion round (tests await it). */
  run(eventId: string): Promise<void>;
  /** Boot: an active event without facilities gets its job. */
  recover(): Promise<void>;
  stop(): void;
}

const floor3 = (n: number) => Math.floor(n * 1000) / 1000;
const ceil3 = (n: number) => Math.ceil(n * 1000) / 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function overpassQuery(b: { s: number; w: number; n: number; e: number }, limit = 300): string {
  const box = `(${b.s},${b.w},${b.n},${b.e})`;
  return `[out:json][timeout:25];(nwr["amenity"="hospital"]${box};nwr["healthcare"="hospital"]${box};nwr["amenity"="shelter"]${box};nwr["emergency"="assembly_point"]${box};nwr["amenity"="fire_station"]${box};);out center ${limit};`;
}

/** Overpass elements (nodes carry lat/lon, ways/relations a `center`) -> facility rows. */
export function parseOverpass(j: any): { kind: Kind; name: string; lat: number; lng: number; osm_id: string; tags: Record<string, string> }[] {
  const out = [] as ReturnType<typeof parseOverpass>;
  const seen = new Set<string>();
  for (const el of j?.elements ?? []) {
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const t = el.tags ?? {};
    const kind: Kind | null = t.amenity === 'hospital' || t.healthcare === 'hospital' ? 'hospital' : t.amenity === 'fire_station' ? 'fire_station' : t.amenity === 'shelter' || t.emergency === 'assembly_point' ? 'shelter' : null;
    if (!kind) continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = kind === 'fire_station' ? 'Fire station' : kind === 'hospital' ? 'Hospital' : 'Shelter';
    out.push({ kind, name: String(t.name ?? `Unnamed ${label.toLowerCase()}`).slice(0, 120), lat, lng, osm_id: id, tags: { ...(t.emergency ? { emergency: String(t.emergency) } : {}), ...(t.amenity ? { amenity: String(t.amenity) } : {}) } });
  }
  return out;
}

export function createFacilities(ctx: Ctx): FacilitiesService {
  const cfg = ctx.cfg;
  const cache = new TtlCache(20);
  const timers = new Map<string, NodeJS.Timeout>();
  let stopped = false;

  const bboxOf = (ev: EventRow) => {
    const r = (ev.region ?? {}) as Record<string, number>;
    if ([r.min_lat, r.min_lng, r.max_lat, r.max_lng].some((x) => typeof x !== 'number')) return null;
    return { s: floor3(r.min_lat), w: floor3(r.min_lng), n: ceil3(r.max_lat), e: ceil3(r.max_lng) };
  };
  const keyOf = (b: { s: number; w: number; n: number; e: number }) => `${b.s},${b.w},${b.n},${b.e}`;

  async function store(ev: EventRow, key: string, rows: ReturnType<typeof parseOverpass>, source: string) {
    await ctx.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('facilities').where('event_id', '=', ev.id).execute();
      for (let i = 0; i < rows.length; i += 200) {
        await trx.insertInto('facilities').values(rows.slice(i, i + 200).map((r) => ({ event_id: ev.id, kind: r.kind, name: r.name, lat: r.lat, lng: r.lng, osm_id: r.osm_id, tags: JSON.stringify(r.tags) as unknown as object }))).execute();
      }
      await trx.updateTable('events').set({ facilities_bbox: key, facilities_fetched_at: new Date(), facilities_source: source, facilities_attempts: 0 }).where('id', '=', ev.id).execute();
    });
  }

  /** Small synthetic set around the event centre so the demo works when Overpass does not. */
  function demoSet(b: { s: number; w: number; n: number; e: number }) {
    const lat = (b.s + b.n) / 2, lng = (b.w + b.e) / 2;
    const dy = Math.max(0.004, (b.n - b.s) / 4), dx = Math.max(0.004, (b.e - b.w) / 4);
    const mk = (kind: Kind, name: string, ox: number, oy: number, i: number) => ({ kind, name, lat: Math.round((lat + oy * dy) * 1e5) / 1e5, lng: Math.round((lng + ox * dx) * 1e5) / 1e5, osm_id: `demo/${i}`, tags: { synthetic: 'true' } as Record<string, string> });
    return [
      mk('hospital', 'Demo Regional Medical Center', 1.2, 0.8, 1), mk('hospital', 'Demo Community Hospital', -1.4, -0.6, 2),
      mk('shelter', 'Demo High School Shelter', -0.5, 1.1, 3), mk('shelter', 'Demo Community Center Shelter', 0.9, -1.2, 4),
      mk('fire_station', 'Demo Fire Station 1', 0.2, 0.3, 5), mk('fire_station', 'Demo Fire Station 2', -1.1, 1.3, 6),
    ];
  }

  async function fetchOverpass(b: { s: number; w: number; n: number; e: number }): Promise<ReturnType<typeof parseOverpass>> {
    const body = `data=${encodeURIComponent(overpassQuery(b))}`;
    let last = 'no endpoint';
    for (const url of cfg.OVERPASS_URLS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await extHttp(ctx, url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeoutMs: cfg.OVERPASS_TIMEOUT_MS });
          if (res.status === 200) return parseOverpass(res.json());
          last = `HTTP ${res.status}`;
          if (res.status !== 429 && res.status !== 504) break; // only these are worth one retry on the same endpoint
          await sleep(cfg.NODE_ENV === 'test' ? 10 : 2000);
        } catch (e) { last = (e as Error).message; break; }
      }
    }
    throw new Error(last);
  }

  async function run(eventId: string): Promise<void> {
    if (stopped) return;
    const ev = await ctx.db.selectFrom('events').selectAll().where('id', '=', eventId).executeTakeFirst();
    if (!ev || ev.status !== 'active') return;
    const b = bboxOf(ev);
    if (!b) return;
    const key = keyOf(b);
    if (ev.facilities_bbox === key && ev.facilities_fetched_at) return; // already ingested for this geofence
    const cached = cache.get<ReturnType<typeof parseOverpass>>(key, 24 * 3600_000);
    if (cached) { await store(ev, key, cached, 'osm'); return; }
    if (!cfg.AGENT_EXTERNAL_TOOLS) {
      if (cfg.DEMO_MODE) await store(ev, key, demoSet(b), 'synthetic_demo');
      return;
    }
    try {
      const rows = await fetchOverpass(b);
      cache.set(key, rows);
      await store(ev, key, rows, 'osm');
      ctx.log.info({ event_id: eventId, facilities: rows.length }, 'facilities ingested');
    } catch (e) {
      const attempts = ev.facilities_attempts + 1;
      await ctx.db.updateTable('events').set({ facilities_attempts: attempts }).where('id', '=', eventId).execute();
      ctx.log.warn({ event_id: eventId, attempts, err: (e as Error).message }, 'facilities ingestion failed');
      if (attempts < cfg.FACILITIES_MAX_ATTEMPTS) {
        const delay = cfg.FACILITIES_BACKOFF_MS[Math.min(attempts - 1, cfg.FACILITIES_BACKOFF_MS.length - 1)] ?? 30_000;
        clearTimeout(timers.get(eventId));
        const t = setTimeout(() => { timers.delete(eventId); if (!stopped) ctx.track(run(eventId)); }, delay);
        t.unref();
        timers.set(eventId, t);
      } else if (cfg.DEMO_MODE) {
        await store(ev, key, demoSet(b), 'synthetic_demo');
        ctx.log.info({ event_id: eventId }, 'facilities: Overpass unavailable, seeded the synthetic demo set');
      }
    }
  }

  return {
    schedule(eventId) { if (!stopped) ctx.track(run(eventId).catch((e) => ctx.log.warn({ err: (e as Error).message }, 'facilities job failed'))); },
    run,
    async recover() {
      const ev = await ctx.db.selectFrom('events').selectAll().where('status', '=', 'active').executeTakeFirst();
      if (ev && ev.facilities_attempts < cfg.FACILITIES_MAX_ATTEMPTS) this.schedule(ev.id);
    },
    stop() { stopped = true; for (const t of timers.values()) clearTimeout(t); timers.clear(); },
  };
}

export async function listFacilities(ctx: Ctx, eventId: string) {
  const ev = await ctx.db.selectFrom('events').selectAll().where('id', '=', eventId).executeTakeFirst();
  if (!ev) throw notFound('Event not found');
  const rows = await ctx.db.selectFrom('facilities').selectAll().where('event_id', '=', eventId).orderBy('kind').orderBy('name').execute();
  return {
    data: rows.map((f): FacilityDto => ({ id: f.id, kind: f.kind, name: f.name, lat: f.lat, lng: f.lng, osm_id: f.osm_id, synthetic: !!(f.tags as any)?.synthetic })),
    source: (ev.facilities_source as 'osm' | 'synthetic_demo' | null) ?? null, fetched_at: ev.facilities_fetched_at ? ev.facilities_fetched_at.toISOString() : null,
  };
}
