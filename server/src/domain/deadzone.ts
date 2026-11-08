/** Grid-cell dead zone detection (design 6.5). Pure. */
export interface Activity { lat: number; lng: number; at: Date; cases?: number }
/** `refLat` fixes the longitude cell width so cell keys stay stable between runs; by default the mean latitude rounded to 0.5 degrees. */
export interface DeadzoneParams { cellKm: number; quietMs: number; minActiveNeighbors: number; now: Date; refLat?: number;
  /** optional filter on candidate cell centres, e.g. inside the event geofence */ keepCell?: (center: { lat: number; lng: number }) => boolean }
export interface DeadzoneCandidate {
  key: string; center: { lat: number; lng: number }; radius_m: number;
  last_activity_at: Date | null; neighbor_case_count: number; active_neighbors: number; reason: string;
}

const KM_PER_DEG = 111.32;
const defaultRef = (acts: Activity[]) => Math.round((acts.reduce((a, x) => a + x.lat, 0) / acts.length) * 2) / 2;

export function cellOf(lat: number, lng: number, cellKm: number, refLatitude: number) {
  const dLat = cellKm / KM_PER_DEG;
  const dLng = cellKm / (KM_PER_DEG * Math.max(Math.cos((refLatitude * Math.PI) / 180), 0.01));
  const row = Math.floor(lat / dLat);
  const col = Math.floor(lng / dLng);
  return { row, col, key: `${row}:${col}`, center: { lat: +((row + 0.5) * dLat).toFixed(5), lng: +((col + 0.5) * dLng).toFixed(5) } };
}

/**
 * A cell is a dead zone when it has had no activity for `quietMs` while enough adjacent cells are active:
 * either >= minActiveNeighbors active neighbours, or it historically had activity and at least one active neighbour.
 */
export function detectDeadzones(acts: Activity[], p: DeadzoneParams): DeadzoneCandidate[] {
  if (!acts.length) return [];
  const ref = p.refLat ?? defaultRef(acts);
  type Cell = { row: number; col: number; last: Date | null; cases: number; center: { lat: number; lng: number } };
  const cells = new Map<string, Cell>();
  for (const a of acts) {
    const c = cellOf(a.lat, a.lng, p.cellKm, ref);
    const cur = cells.get(c.key) ?? { row: c.row, col: c.col, last: null, cases: 0, center: c.center };
    if (!cur.last || a.at > cur.last) cur.last = a.at;
    cur.cases += a.cases ?? 1;
    cells.set(c.key, cur);
  }
  const cutoff = p.now.getTime() - p.quietMs;
  const isActive = (c?: Cell) => !!c && !!c.last && c.last.getTime() > cutoff;
  const candidates = new Set<string>();
  for (const c of cells.values()) {
    candidates.add(`${c.row}:${c.col}`);
    if (isActive(c)) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) candidates.add(`${c.row + dr}:${c.col + dc}`);
  }
  const out: DeadzoneCandidate[] = [];
  const dLat = p.cellKm / KM_PER_DEG;
  for (const key of candidates) {
    const [row, col] = key.split(':').map(Number);
    const cell = cells.get(key);
    if (isActive(cell)) continue;
    let activeN = 0, caseN = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const n = cells.get(`${row + dr}:${col + dc}`);
      if (isActive(n)) { activeN++; caseN += n!.cases; }
    }
    const history = !!cell;
    if (!(activeN >= p.minActiveNeighbors || (history && activeN >= 1))) continue;
    const dLng = p.cellKm / (KM_PER_DEG * Math.max(Math.cos((ref * Math.PI) / 180), 0.01));
    const center = cell?.center ?? { lat: +((row + 0.5) * dLat).toFixed(5), lng: +((col + 0.5) * dLng).toFixed(5) };
    if (p.keepCell && !p.keepCell(center)) continue;
    const quietMin = Math.round(p.quietMs / 60000);
    out.push({
      key, center, radius_m: Math.round(p.cellKm * 1000 * 0.7071), last_activity_at: cell?.last ?? null, neighbor_case_count: caseN, active_neighbors: activeN,
      reason: `No reports, check-ins or heartbeats for ${quietMin} min${cell ? '' : ' (never heard from)'}; ${activeN} neighbouring cells have ${caseN} active items`,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
