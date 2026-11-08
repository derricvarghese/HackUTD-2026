import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Deadzone, HeatCell, Offer, Responder, Sos } from '../api/models';
import { hopChips, hopSummary } from '../lib/hops';
import { formatRadius, resolveLocation } from '../lib/privacy';
import { regionBox } from '../lib/region';
import { CATEGORY_LABEL, TIER_HEX, TIER_LABEL, TIER_TEXT, caseKind, scoreTier, shortId } from '../lib/tier';
import { formatAge } from '../lib/time';
import { useUi, type LayerKey } from '../state/ui';

export interface MapBounds {
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
}

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_CENTER: L.LatLngTuple = [32.78, -96.8];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, style?: Partial<CSSStyleDeclaration>): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  if (style) Object.assign(n.style, style);
  return n;
}

/** Popup DOM like the mock's .pop: score, summary, hop chain and the honest precision of the position. Text goes in via textContent. */
export function buildCasePopup(c: Sos, onOpen: () => void): HTMLElement {
  const kind = caseKind(c);
  const loc = resolveLocation(c);
  const root = el('div', 'pop', undefined, { borderTop: `4px solid ${TIER_HEX[kind]}` });
  root.style.padding = '12px 14px';
  const hd = el('div', 'hd');
  hd.append(el('span', undefined, `${shortId(c.id)} · ${CATEGORY_LABEL[c.category]}`));
  const sc = el('span', 'score', String(c.score), { background: TIER_HEX[kind], color: TIER_TEXT[kind] });
  sc.title = TIER_LABEL[kind];
  hd.append(sc);
  root.append(hd);
  root.append(el('div', undefined, (c.text ?? 'No message text').slice(0, 110), { color: '#475569', marginTop: '4px' }));
  root.append(el('div', undefined, c.channel === 'app' ? 'Sent directly from an online phone' : hopSummary(c.hop), { marginTop: '8px', fontWeight: '600' }));
  if (c.channel === 'mesh') {
    const hops = el('div', 'hops');
    hopChips(c.hop).forEach((h, i) => {
      if (i > 0) hops.append(el('span', 'arr', '→'));
      hops.append(el('span', h.gateway ? 'hop gw' : 'hop', h.label));
    });
    root.append(hops);
  }
  const foot = [
    c.hop?.max_hops !== undefined ? `Max hops ${c.hop.max_hops}` : null,
    c.silent ? 'went silent' : null,
    `heard ${formatAge(c.last_heard_at)}`,
    loc.precision === 'exact' ? 'exact location (you are assigned)' : `approximate area, within ${formatRadius(loc.radius_m)}`,
  ].filter(Boolean);
  root.append(el('div', undefined, foot.join(' · '), { marginTop: '8px', color: '#64748B', fontSize: '11.5px' }));
  const btns = el('div', 'btns');
  const open = el('button', 'p', 'Open case');
  open.type = 'button';
  open.addEventListener('click', onOpen);
  btns.append(open);
  root.append(btns);
  return root;
}

function pinIcon(c: Sos, selected: boolean): L.DivIcon {
  const kind = caseKind(c);
  const big = kind === 'critical';
  const w = big ? 44 : 36;
  const h = big ? 52 : 44;
  const fill = TIER_HEX[kind];
  const svg = `<svg width="${w}" height="${h}" viewBox="0 0 44 52"><path d="M22 50C8 34 0 25 0 14a22 22 0 0144 0c0 11-8 20-22 36z" fill="${fill}" stroke="#fff" stroke-width="3"/><text x="22" y="22" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700" font-size="${big ? 16 : 17}" fill="${TIER_TEXT[kind]}">${c.score}</text></svg>`;
  return L.divIcon({
    className: `pin${selected ? ' sel' : ''}`,
    html: `${c.silent ? '<span class="sring"></span>' : ''}${svg}`,
    iconSize: [w, h],
    iconAnchor: [w / 2, h],
    popupAnchor: [0, -h + 6],
  });
}

function dotIcon(color: string, label?: string): L.DivIcon {
  if (label) {
    return L.divIcon({
      className: 'pin',
      html: `<svg width="30" height="38" viewBox="0 0 44 52"><path d="M22 50C8 34 0 25 0 14a22 22 0 0144 0c0 11-8 20-22 36z" fill="${color}" stroke="#fff" stroke-width="3"/><text x="22" y="22" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700" font-size="16" fill="#fff">${label}</text></svg>`,
      iconSize: [30, 38],
      iconAnchor: [15, 38],
    });
  }
  return L.divIcon({ className: 'dot-marker', html: `<i style="background:${color}"></i>`, iconSize: [14, 14], iconAnchor: [7, 7] });
}

const LAYER_LABELS: [LayerKey, string][] = [
  ['sos', 'SOS Cases'],
  ['approx', 'Approx. areas'],
  ['heat', 'Heat'],
  ['responders', 'Responders'],
  ['offers', 'Neighbor offers'],
  ['deadzones', 'Dead Zones'],
];

export interface MapViewProps {
  cases: Sos[];
  responders?: Responder[];
  offers?: Offer[];
  deadzones?: Deadzone[];
  heat?: HeatCell[];
  region?: unknown;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenCase?: (id: string) => void;
  onBounds?: (b: MapBounds) => void;
  onDeadzone?: (d: Deadzone, status: Deadzone['status']) => void;
  className?: string;
}

export function MapView(p: MapViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const groups = useRef<Record<LayerKey, L.LayerGroup> | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const fittedFor = useRef<string | null>(null);
  const cb = useRef(p);
  cb.current = p;
  const layers = useUi((s) => s.layers);
  const toggle = useUi((s) => s.toggleLayer);
  const [tilesOk, setTilesOk] = useState(true);

  // create the map once
  useEffect(() => {
    if (!host.current || mapRef.current) return;
    const map = L.map(host.current, { zoomControl: false, attributionControl: true, zoomAnimation: false }).setView(DEFAULT_CENTER, 11);
    const tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
    let errors = 0;
    tiles.on('tileerror', () => {
      errors++;
      if (errors > 3) setTilesOk(false);
    });
    tiles.on('tileload', () => {
      errors = 0;
      setTilesOk(true);
    });
    tiles.addTo(map);
    groups.current = {
      heat: L.layerGroup().addTo(map),
      deadzones: L.layerGroup().addTo(map),
      approx: L.layerGroup().addTo(map),
      offers: L.layerGroup().addTo(map),
      responders: L.layerGroup().addTo(map),
      sos: L.layerGroup().addTo(map),
    };
    const emit = () => {
      const b = map.getBounds();
      const nb = { min_lat: b.getSouth(), min_lng: b.getWest(), max_lat: b.getNorth(), max_lng: b.getEast() };
      useUi.setState({ mapBounds: nb });
      cb.current.onBounds?.(nb);
    };
    map.on('moveend', emit);
    mapRef.current = map;
    emit();
    const ro = new ResizeObserver(() => { if (mapRef.current === map) map.invalidateSize(); });
    ro.observe(host.current);
    const mk = markers.current;
    return () => {
      ro.disconnect();
      map.stop();
      map.off();
      map.remove();
      mapRef.current = null;
      groups.current = null;
      mk.clear();
    };
  }, []);

  // layer visibility
  useEffect(() => {
    const map = mapRef.current;
    const g = groups.current;
    if (!map || !g) return;
    (Object.keys(g) as LayerKey[]).forEach((k) => {
      if (layers[k] && !map.hasLayer(g[k])) g[k].addTo(map);
      if (!layers[k] && map.hasLayer(g[k])) map.removeLayer(g[k]);
    });
  }, [layers]);

  // fit to the event region (once per region) or to the cases
  const regionKey = p.region ? JSON.stringify(p.region) : null;
  const caseCount = p.cases.length;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const r = regionBox(p.region);
    const key = r ? regionKey : caseCount ? 'cases' : null;
    if (!key || fittedFor.current === key) return;
    if (r) {
      map.fitBounds([[r.min_lat, r.min_lng], [r.max_lat, r.max_lng]], { padding: [30, 30] });
    } else if (caseCount) {
      const pts = cb.current.cases.map((c) => { const l = resolveLocation(c); return [l.lat, l.lng] as L.LatLngTuple; });
      map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 14 });
    } else return;
    fittedFor.current = key;
  }, [regionKey, caseCount, p.region]);

  // cases: pins + approx circles
  useEffect(() => {
    const g = groups.current;
    if (!g) return;
    g.sos.clearLayers();
    g.approx.clearLayers();
    markers.current.clear();
    for (const c of p.cases) {
      const loc = resolveLocation(c);
      const kind = caseKind(c);
      const selected = c.id === p.selectedId;
      if (loc.precision === 'approx') {
        L.circle([loc.lat, loc.lng], { radius: loc.radius_m, color: TIER_HEX[kind], weight: selected ? 2.5 : 1.5, dashArray: '4 4', fillColor: TIER_HEX[kind], fillOpacity: selected ? 0.18 : 0.07, interactive: false }).addTo(g.approx);
      }
      const m = L.marker([loc.lat, loc.lng], { icon: pinIcon(c, selected), keyboard: true, title: `${shortId(c.id)} score ${c.score}`, zIndexOffset: Math.round(c.score) + (selected ? 1000 : 0) });
      m.bindPopup(() => buildCasePopup(c, () => cb.current.onOpenCase?.(c.id)), { closeButton: false, maxWidth: 270, minWidth: 250, autoPanPadding: [30, 80] });
      m.on('click', () => cb.current.onSelect(c.id));
      m.addTo(g.sos);
      markers.current.set(c.id, m);
    }
    const sel = p.selectedId ? markers.current.get(p.selectedId) : undefined;
    if (sel && !sel.isPopupOpen()) sel.openPopup();
  }, [p.cases, p.selectedId]);

  // selecting a case from outside pans to it
  const lastPan = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !p.selectedId || lastPan.current === p.selectedId) return;
    const c = p.cases.find((x) => x.id === p.selectedId);
    if (!c) return;
    lastPan.current = p.selectedId;
    const l = resolveLocation(c);
    if (!map.getBounds().pad(-0.15).contains([l.lat, l.lng])) map.panTo([l.lat, l.lng]);
    markers.current.get(p.selectedId)?.openPopup();
  }, [p.selectedId, p.cases]);

  // heat
  useEffect(() => {
    const g = groups.current;
    if (!g) return;
    g.heat.clearLayers();
    const max = Math.max(1, ...(p.heat ?? []).map((h) => h.count));
    for (const h of p.heat ?? []) {
      const color = TIER_HEX[scoreTier(h.max_score)];
      L.circle([h.lat, h.lng], { radius: 700, stroke: false, fillColor: color, fillOpacity: 0.18 + 0.3 * (h.count / max), interactive: false }).addTo(g.heat);
    }
  }, [p.heat]);

  // dead zones
  useEffect(() => {
    const g = groups.current;
    if (!g) return;
    g.deadzones.clearLayers();
    for (const d of p.deadzones ?? []) {
      if (d.status === 'dismissed') continue;
      const checked = d.status === 'being_checked';
      const c = L.circle([d.center.lat, d.center.lng], { radius: d.radius_m, color: checked ? '#B45309' : '#334155', weight: 1.5, dashArray: '5 4', fillColor: '#334155', fillOpacity: 0.12 });
      c.bindTooltip(checked ? 'DEAD ZONE · being checked' : 'DEAD ZONE', { sticky: true, className: 'dz-label' });
      c.bindPopup(() => {
        const root = el('div', 'pop', undefined, { borderTop: '4px solid #334155', padding: '12px 14px' });
        root.append(el('div', 'hd', 'Dead zone'));
        root.append(el('div', undefined, d.reason ?? 'No check-ins or reports from this area.', { color: '#475569', marginTop: '4px' }));
        root.append(el('div', undefined, `Last activity ${d.last_activity_at ? formatAge(d.last_activity_at) : 'never'}${d.neighbor_case_count !== undefined ? ` · ${d.neighbor_case_count} nearby cases` : ''}`, { color: '#64748B', fontSize: '11.5px', marginTop: '6px' }));
        const b = el('div', 'btns');
        const mk = (label: string, st: Deadzone['status'], primary?: boolean) => {
          const x = el('button', primary ? 'p' : '', label);
          x.type = 'button';
          x.addEventListener('click', () => cb.current.onDeadzone?.(d, st));
          return x;
        };
        if (!checked) b.append(mk('Being checked', 'being_checked', true));
        b.append(mk('Dismiss', 'dismissed'));
        root.append(b);
        return root;
      });
      c.addTo(g.deadzones);
    }
  }, [p.deadzones]);

  // responders and offers
  useEffect(() => {
    const g = groups.current;
    if (!g) return;
    g.responders.clearLayers();
    for (const r of p.responders ?? []) {
      if (!r.location) continue;
      const initials = r.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
      L.marker([r.location.lat, r.location.lng], { icon: dotIcon('#2563EB', initials), title: `${r.name}${r.available ? ' (available)' : ''}` }).bindTooltip(`${r.name}${r.organization ? ` · ${r.organization}` : ''}`).addTo(g.responders);
    }
  }, [p.responders]);
  useEffect(() => {
    const g = groups.current;
    if (!g) return;
    g.offers.clearLayers();
    for (const o of p.offers ?? []) {
      if (o.status !== 'open' && o.status !== 'matched') continue;
      const a = o.approx_location;
      L.circle([a.lat, a.lng], { radius: a.radius_m, color: '#16A34A', weight: 1, dashArray: '2 4', fillOpacity: 0.05, interactive: false }).addTo(g.offers);
      L.marker([a.lat, a.lng], { icon: dotIcon('#16A34A'), title: `Offer: ${o.kind}` }).bindTooltip(`${o.kind}${o.description ? `: ${o.description}` : ''} (approximate)`).addTo(g.offers);
    }
  }, [p.offers]);

  const fit = () => {
    fittedFor.current = null;
    const map = mapRef.current;
    if (!map) return;
    const r = regionBox(p.region);
    if (r) map.fitBounds([[r.min_lat, r.min_lng], [r.max_lat, r.max_lng]], { padding: [30, 30] });
    else if (p.cases.length) map.fitBounds(L.latLngBounds(p.cases.map((c) => { const l = resolveLocation(c); return [l.lat, l.lng] as L.LatLngTuple; })), { padding: [60, 60], maxZoom: 14 });
    else map.setView(DEFAULT_CENTER, 11);
  };

  const legend = useMemo(
    () => [
      ['#D32F2F', 'Critical SOS (80+)', ''],
      ['#F59E0B', 'High (50–79)', ''],
      ['#2563EB', 'Normal (20–49)', ''],
      ['#15803D', 'Low / safe (<20)', ''],
      ['#7C3AED', 'Went silent', ''],
    ],
    [],
  );

  return (
    <div className={`card map ${p.className ?? ''}`} role="region" aria-label="Incident map">
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <div className="layers">
        <div className="t">LAYERS</div>
        {LAYER_LABELS.map(([k, label]) => (
          <label key={k}>
            <input type="checkbox" checked={layers[k]} onChange={() => toggle(k)} />
            {label}
          </label>
        ))}
      </div>
      <div className="zoom">
        <button type="button" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>−</button>
        <button type="button" aria-label="Fit to the event area" onClick={fit}>⌖</button>
      </div>
      {!tilesOk && <div className="map-hint">Map tiles unreachable. Showing cases on a blank background.</div>}
      <div className="legend">
        <span className="lg-t">Legend</span>
        {legend.map(([c, l]) => (
          <div key={l}><span className="sw" style={{ background: c }} />{l}</div>
        ))}
        <div><span className="sw" style={{ background: '#2563EB', borderRadius: '50%', width: 12 }} />Responder</div>
        <div><span className="sw" style={{ background: '#16A34A', borderRadius: '50%', width: 12, opacity: 0.7 }} />Neighbor offer</div>
        <div><span className="sw" style={{ border: '1.5px dashed #334155', background: 'rgba(51,65,85,.15)' }} />Dead zone (no check-ins)</div>
        <div><span className="sw" style={{ border: '1.5px dashed #D32F2F', borderRadius: '50%', width: 12 }} />Approximate area</div>
      </div>
    </div>
  );
}

