import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useDebounced } from '../hooks/useDebounced';
import { searchPlaces, type Place } from '../lib/geocode';
import { MAX_VERTICES, analyseShape, fmtArea, fmtLen, shapeRing, translateShape, type Shape } from '../lib/geofenceShape';
import type { ShapeHistory } from '../lib/shapeHistory';
import { useUi } from '../state/ui';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_CENTER: L.LatLngTuple = [32.78, -96.8];
const COLOR = '#0E7490';

type Mode = 'idle' | 'polygon' | 'rectangle' | 'circle';
export interface GeofenceEditorHandle {
  /** Cancels an unfinished drawing; true when there was one (used to swallow Escape in the dialog). */
  cancelDraw: () => boolean;
}

interface Props {
  hist: ShapeHistory;
  readOnly?: boolean;
  onDrawingChange?: (drawing: boolean) => void;
  ref?: Ref<GeofenceEditorHandle>;
}

const toLL = (p: [number, number]): L.LatLngTuple => [p[1], p[0]];
const handleIcon = (cls: string) => L.divIcon({ className: `gf-h ${cls}`, iconSize: cls.includes('mid') ? [10, 10] : [14, 14] });

interface Handle { marker: L.Marker; pos: (s: Shape) => L.LatLngTuple }

export function GeofenceEditor({ hist, readOnly = false, onDrawingChange, ref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const groups = useRef<{ shape: L.LayerGroup; handles: L.LayerGroup; draft: L.LayerGroup; me: L.LayerGroup } | null>(null);
  const poly = useRef<L.Polygon | null>(null);
  const handles = useRef<Handle[]>([]);
  const dragging = useRef<L.Marker | 'move' | null>(null);
  const modeRef = useRef<Mode>('idle');
  const pts = useRef<L.LatLng[]>([]);
  const start = useRef<{ ll: L.LatLng; px: L.Point } | null>(null);
  const cursor = useRef<L.LatLng | null>(null);
  const histRef = useRef(hist);
  histRef.current = hist;
  const [mode, setMode] = useState<Mode>('idle');
  const [draft, setDraft] = useState<Shape | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const selRef = useRef<number | null>(null);
  selRef.current = sel;
  const [tick, setTick] = useState(0);
  const [tilesOk, setTilesOk] = useState(true);
  const [note, setNote] = useState('');
  const [drawn, setDrawn] = useState(0);
  const [hasStart, setHasStart] = useState(false);

  const shape = hist.shape;
  const drawing = mode !== 'idle';

  // ---------- map creation
  useEffect(() => {
    if (!host.current || mapRef.current) return;
    const map = L.map(host.current, { zoomControl: false, doubleClickZoom: false, zoomAnimation: false }).setView(DEFAULT_CENTER, 11);
    const tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
    let errors = 0;
    tiles.on('tileerror', () => { errors++; if (errors > 3) setTilesOk(false); });
    tiles.on('tileload', () => { errors = 0; setTilesOk(true); });
    tiles.addTo(map);
    groups.current = { shape: L.layerGroup().addTo(map), handles: L.layerGroup().addTo(map), draft: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map) };
    mapRef.current = map;
    const first = histRef.current.shape;
    const ui = useUi.getState().mapBounds;
    if (first) map.fitBounds(L.latLngBounds(shapeRing(first).map(toLL)), { padding: [30, 30], animate: false });
    else if (ui) map.fitBounds([[ui.min_lat, ui.min_lng], [ui.max_lat, ui.max_lng]], { animate: false });
    const ro = new ResizeObserver(() => { if (mapRef.current === map) map.invalidateSize(); });
    ro.observe(host.current);
    return () => { ro.disconnect(); map.stop(); map.off(); map.remove(); mapRef.current = null; groups.current = null; };
  }, []);

  const fitShape = useCallback((s: Shape | null = histRef.current.shape) => {
    if (s && mapRef.current) mapRef.current.fitBounds(L.latLngBounds(shapeRing(s).map(toLL)), { padding: [40, 40] });
  }, []);

  // ---------- committed shape: outline + handles
  const sync = useCallback(() => {
    const g = groups.current;
    const map = mapRef.current;
    if (!g || !map) return;
    const s = histRef.current.shape;
    const idle = modeRef.current === 'idle';
    const editable = !readOnly && idle;
    if (dragging.current && poly.current && s) {
      // in-place update while a handle or the body is being dragged
      poly.current.setLatLngs(shapeRing(s).map(toLL));
      for (const h of handles.current) if (h.marker !== dragging.current) h.marker.setLatLng(h.pos(s));
      return;
    }
    g.shape.clearLayers();
    g.handles.clearLayers();
    poly.current = null;
    handles.current = [];
    if (!s) return;
    const p = L.polygon(shapeRing(s).map(toLL), {
      color: idle ? COLOR : '#64748B', weight: idle ? 2.5 : 1.5, dashArray: idle ? undefined : '4 4', fillColor: COLOR, fillOpacity: idle ? 0.12 : 0.04, interactive: editable, bubblingMouseEvents: false,
    }).addTo(g.shape);
    poly.current = p;
    if (!editable) return;
    const el = p.getElement();
    if (el) el.classList.add('gf-body');

    // move the whole shape by dragging its body
    p.on('mousedown', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e);
      const base = histRef.current.shape;
      if (!base) return;
      const origin = e.latlng;
      let moved = false;
      map.dragging.disable();
      dragging.current = 'move';
      const mv = (ev: L.LeafletMouseEvent) => {
        if (!moved) { moved = true; histRef.current.begin(); }
        histRef.current.replace(translateShape(base, ev.latlng.lat - origin.lat, ev.latlng.lng - origin.lng));
      };
      const up = () => {
        map.off('mousemove', mv);
        document.removeEventListener('mouseup', up);
        map.dragging.enable();
        dragging.current = null;
        setTick((t) => t + 1);
      };
      map.on('mousemove', mv);
      document.addEventListener('mouseup', up);
    });

    const add = (marker: L.Marker, pos: (x: Shape) => L.LatLngTuple) => { marker.addTo(g.handles); handles.current.push({ marker, pos }); };
    const dragger = (cls: string, title: string, at: L.LatLngTuple, onDrag: (ll: L.LatLng, base: Shape) => Shape, onClick?: () => void, pos?: (x: Shape) => L.LatLngTuple) => {
      const m = L.marker(at, { icon: handleIcon(cls), draggable: true, keyboard: true, title, zIndexOffset: 500 });
      let base: Shape | null = null;
      m.on('dragstart', () => { base = histRef.current.shape; dragging.current = m; histRef.current.begin(); });
      m.on('drag', () => { if (base) histRef.current.replace(onDrag(m.getLatLng(), base)); });
      m.on('dragend', () => { dragging.current = null; base = null; setTick((t) => t + 1); });
      if (onClick) m.on('click', onClick);
      add(m, pos ?? (() => at));
      return m;
    };

    if (s.kind === 'polygon') {
      const n = s.ring.length;
      s.ring.forEach((v, i) => {
        const m = dragger(`v${selRef.current === i ? ' sel' : ''}`, `Vertex ${i + 1} of ${n}. Drag to move; Delete key or double-click removes it.`, toLL(v),
          (ll, base) => (base.kind === 'polygon' ? { kind: 'polygon', ring: base.ring.map((q, j) => (j === i ? [ll.lng, ll.lat] : q)) } : base),
          () => setSel(i), (x) => (x.kind === 'polygon' && x.ring[i] ? toLL(x.ring[i]) : toLL(v)));
        m.on('dblclick contextmenu', (e) => { L.DomEvent.stop(e); removeVertex(i); });
      });
      if (n < MAX_VERTICES) {
        s.ring.forEach((v, i) => {
          const w = s.ring[(i + 1) % n];
          const mid = (x: Shape): L.LatLngTuple => { const r = x.kind === 'polygon' ? x.ring : []; const a = r[i] ?? v, b = r[(i + 1) % Math.max(r.length, 1)] ?? w; return [(a[1] + b[1]) / 2, (a[0] + b[0]) / 2]; };
          const m = L.marker(mid(s), { icon: handleIcon('mid'), keyboard: false, title: 'Add a vertex here', zIndexOffset: 400 });
          m.on('click', () => {
            const cur = histRef.current.shape;
            if (cur?.kind !== 'polygon') return;
            const ring = cur.ring.slice();
            const at = mid(cur);
            ring.splice(i + 1, 0, [at[1], at[0]]);
            histRef.current.commit({ kind: 'polygon', ring });
            setSel(i + 1);
          });
          add(m, mid);
        });
      }
    } else if (s.kind === 'rectangle') {
      const corners: [string, (b: Shape & { kind: 'rectangle' }) => L.LatLngTuple, (b: Shape & { kind: 'rectangle' }) => L.LatLngTuple][] = [
        ['south-west', (r) => [r.bounds.min_lat, r.bounds.min_lng], (r) => [r.bounds.max_lat, r.bounds.max_lng]],
        ['south-east', (r) => [r.bounds.min_lat, r.bounds.max_lng], (r) => [r.bounds.max_lat, r.bounds.min_lng]],
        ['north-east', (r) => [r.bounds.max_lat, r.bounds.max_lng], (r) => [r.bounds.min_lat, r.bounds.min_lng]],
        ['north-west', (r) => [r.bounds.max_lat, r.bounds.min_lng], (r) => [r.bounds.min_lat, r.bounds.max_lng]],
      ];
      for (const [name, at, opposite] of corners) {
        dragger('v', `${name} corner. Drag to resize.`, at(s), (ll, base) => {
          if (base.kind !== 'rectangle') return base;
          const o = opposite(base);
          return { kind: 'rectangle', bounds: { min_lat: Math.min(o[0], ll.lat), max_lat: Math.max(o[0], ll.lat), min_lng: Math.min(o[1], ll.lng), max_lng: Math.max(o[1], ll.lng) } };
        }, undefined, (x) => (x.kind === 'rectangle' ? at(x) : at(s as Shape & { kind: 'rectangle' })));
      }
    } else {
      const east = (c: Shape & { kind: 'circle' }): L.LatLngTuple => [c.lat, c.lng + c.radius_m / (111_320 * Math.max(Math.cos((c.lat * Math.PI) / 180), 0.01))];
      dragger('v ctr', 'Circle centre. Drag to move.', [s.lat, s.lng], (ll, base) => (base.kind === 'circle' ? { ...base, lat: ll.lat, lng: ll.lng } : base), undefined, (x) => (x.kind === 'circle' ? [x.lat, x.lng] : [s.lat, s.lng]));
      dragger('v', 'Radius handle. Drag to resize.', east(s), (ll, base) => (base.kind === 'circle' ? { ...base, radius_m: Math.max(1, map.distance([base.lat, base.lng], ll)) } : base), undefined, (x) => (x.kind === 'circle' ? east(x) : east(s)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  const removeVertex = useCallback((i: number) => {
    const cur = histRef.current.shape;
    if (cur?.kind !== 'polygon') return;
    if (cur.ring.length <= 3) { setNote('A polygon needs at least 3 vertices.'); return; }
    histRef.current.commit({ kind: 'polygon', ring: cur.ring.filter((_, j) => j !== i) });
    setSel(null);
  }, []);

  useEffect(() => { sync(); }, [shape, mode, sel, tick, sync]);

  // ---------- drawing
  const renderDraft = useCallback(() => {
    const g = groups.current;
    if (!g) return;
    g.draft.clearLayers();
    const m = modeRef.current;
    const c = cursor.current;
    const style = { color: COLOR, weight: 2.5, dashArray: '6 4', fillColor: COLOR, fillOpacity: 0.1, interactive: false } as const;
    let d: Shape | null = null;
    if (m === 'polygon') {
      const p = pts.current;
      if (p.length) {
        if (p.length >= 3) L.polygon(p, { ...style, stroke: false }).addTo(g.draft);
        L.polyline(c ? [...p, c] : p, { ...style, fillOpacity: 0 }).addTo(g.draft);
        p.forEach((q, i) => {
          const mk = L.circleMarker(q, { radius: i === 0 ? 8 : 5, color: i === 0 && p.length >= 3 ? '#15803D' : COLOR, weight: 2, fillColor: '#fff', fillOpacity: 1, bubblingMouseEvents: false });
          if (i === 0 && p.length >= 3) { mk.bindTooltip('Click to close the shape', { direction: 'top' }); mk.on('click', () => finishPolygon()); }
          mk.addTo(g.draft);
        });
        if (p.length >= 3) d = { kind: 'polygon', ring: p.map((q) => [q.lng, q.lat]) };
      }
    } else if (start.current && c) {
      const a = start.current.ll;
      if (m === 'rectangle') {
        L.rectangle(L.latLngBounds(a, c), style).addTo(g.draft);
        if (a.lat !== c.lat && a.lng !== c.lng) d = { kind: 'rectangle', bounds: { min_lat: Math.min(a.lat, c.lat), max_lat: Math.max(a.lat, c.lat), min_lng: Math.min(a.lng, c.lng), max_lng: Math.max(a.lng, c.lng) } };
      } else if (m === 'circle') {
        const r = mapRef.current?.distance(a, c) ?? 0;
        if (r > 0) { L.circle(a, { ...style, radius: r }).addTo(g.draft); d = { kind: 'circle', lat: a.lat, lng: a.lng, radius_m: r }; }
      }
    }
    setDraft(d);
    setDrawn(pts.current.length);
    setHasStart(!!start.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetDraft = useCallback(() => { pts.current = []; start.current = null; cursor.current = null; groups.current?.draft.clearLayers(); setDraft(null); setDrawn(0); setHasStart(false); }, []);
  const changeMode = useCallback((m: Mode) => {
    modeRef.current = m;
    setMode(m);
    resetDraft();
    setSel(null);
    setNote('');
    const map = mapRef.current;
    if (map) {
      if (m === 'idle') map.dragging.enable(); else if (m !== 'polygon') map.dragging.disable(); else map.dragging.enable();
      map.getContainer().classList.toggle('gf-drawing', m !== 'idle');
    }
    onDrawingChange?.(m !== 'idle');
  }, [onDrawingChange, resetDraft]);

  const finishPolygon = useCallback(() => {
    if (pts.current.length < 3) { setNote('Place at least 3 vertices first.'); return; }
    histRef.current.commit({ kind: 'polygon', ring: pts.current.map((q) => [q.lng, q.lat]) });
    changeMode('idle');
  }, [changeMode]);
  const finishTwoPoint = useCallback((a: L.LatLng, b: L.LatLng) => {
    const m = modeRef.current;
    if (m === 'rectangle') {
      if (a.lat === b.lat || a.lng === b.lng) return false;
      histRef.current.commit({ kind: 'rectangle', bounds: { min_lat: Math.min(a.lat, b.lat), max_lat: Math.max(a.lat, b.lat), min_lng: Math.min(a.lng, b.lng), max_lng: Math.max(a.lng, b.lng) } });
    } else {
      const r = mapRef.current?.distance(a, b) ?? 0;
      if (r < 1) return false;
      histRef.current.commit({ kind: 'circle', lat: a.lat, lng: a.lng, radius_m: r });
    }
    changeMode('idle');
    return true;
  }, [changeMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || readOnly) return;
    const onClick = (e: L.LeafletMouseEvent) => {
      if (modeRef.current !== 'polygon') return;
      if (pts.current.length >= MAX_VERTICES) { setNote(`At most ${MAX_VERTICES} vertices.`); return; }
      pts.current = [...pts.current, e.latlng];
      cursor.current = e.latlng;
      renderDraft();
    };
    const onMove = (e: L.LeafletMouseEvent) => { cursor.current = e.latlng; if (modeRef.current !== 'idle') renderDraft(); };
    const onDown = (e: L.LeafletMouseEvent) => {
      const m = modeRef.current;
      if (m !== 'rectangle' && m !== 'circle') return;
      if (start.current) { finishTwoPoint(start.current.ll, e.latlng); return; }
      start.current = { ll: e.latlng, px: e.containerPoint };
      cursor.current = e.latlng;
      renderDraft();
    };
    const onUp = (e: L.LeafletMouseEvent) => {
      const m = modeRef.current;
      if ((m === 'rectangle' || m === 'circle') && start.current && start.current.px.distanceTo(e.containerPoint) > 8) finishTwoPoint(start.current.ll, e.latlng);
    };
    map.on('click', onClick).on('mousemove', onMove).on('mousedown', onDown).on('mouseup', onUp);
    return () => { map.off('click', onClick).off('mousemove', onMove).off('mousedown', onDown).off('mouseup', onUp); };
  }, [readOnly, renderDraft, finishTwoPoint]);

  const cancelDraw = useCallback(() => {
    if (modeRef.current === 'idle') return false;
    changeMode('idle');
    return true;
  }, [changeMode]);
  useImperativeHandle(ref, () => ({ cancelDraw }), [cancelDraw]);

  // ---------- toolbar actions
  const undo = () => {
    if (modeRef.current === 'polygon' && pts.current.length) { pts.current = pts.current.slice(0, -1); renderDraft(); return; }
    if (modeRef.current !== 'idle') { resetDraft(); return; }
    hist.undo();
  };
  const useView = () => {
    const b = mapRef.current?.getBounds();
    if (!b) return;
    if (modeRef.current !== 'idle') changeMode('idle');
    hist.commit({ kind: 'rectangle', bounds: { min_lat: b.getSouth(), min_lng: b.getWest(), max_lat: b.getNorth(), max_lng: b.getEast() } });
    setNote('Rectangle set to the visible map area.');
  };
  const locate = () => {
    if (!navigator.geolocation) { setNote('Your browser cannot share its location.'); return; }
    setNote('Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const ll: L.LatLngTuple = [pos.coords.latitude, pos.coords.longitude];
        mapRef.current?.setView(ll, Math.max(mapRef.current.getZoom(), 13));
        groups.current?.me.clearLayers();
        L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#2563EB', fillOpacity: 1, interactive: false }).addTo(groups.current!.me);
        setNote('Centred on your location.');
      },
      () => setNote('Could not get your location. Allow location access or search for a place instead.'),
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  };
  const addAtCentre = () => {
    const c = mapRef.current?.getCenter();
    if (!c || modeRef.current !== 'polygon') return;
    pts.current = [...pts.current, c];
    cursor.current = null;
    renderDraft();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) hist.redo(); else undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); hist.redo(); }
    else if (e.key === 'Enter' && modeRef.current === 'polygon' && t.tagName !== 'BUTTON') { e.preventDefault(); finishPolygon(); }
    else if (e.key === 'Backspace' && modeRef.current === 'polygon') { e.preventDefault(); undo(); }
    else if (e.key === 'Delete' && sel !== null) { e.preventDefault(); removeVertex(sel); }
  };

  // ---------- place search
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 700);
  const [results, setResults] = useState<Place[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'busy' | 'none' | 'error'>('idle');
  const [forced, setForced] = useState(0);
  useEffect(() => {
    const term = dq.trim();
    if (term.length < 3) return;
    const ctl = new AbortController();
    setSearchState('busy');
    searchPlaces(term, ctl.signal).then(
      (r) => { setResults(r); setSearchState(r.length ? 'idle' : 'none'); },
      (e: unknown) => { if ((e as { name?: string })?.name !== 'AbortError') { setResults([]); setSearchState('error'); } },
    );
    return () => ctl.abort();
  }, [dq, forced]);
  const showResults = q.trim().length >= 3 ? results : [];
  const pick = (p: Place) => {
    const map = mapRef.current;
    if (!map) return;
    if (p.bounds) map.fitBounds(p.bounds, { maxZoom: 15 }); else map.setView([p.lat, p.lng], 13);
    setResults([]);
    setQ('');
    setSearchState('idle');
    setNote(`Moved the map to ${p.name.split(',')[0]}. Now draw the area.`);
  };

  const live = draft ?? shape;
  const info = useMemo(() => analyseShape(live), [live]);
  const toolBtn = (m: Exclude<Mode, 'idle'>, label: string, hint: string) => (
    <button type="button" className="btn sm" aria-pressed={mode === m} onClick={() => changeMode(mode === m ? 'idle' : m)} title={hint}>{label}</button>
  );
  const help = readOnly ? 'This event is closed, so its area can no longer be changed.'
    : mode === 'polygon' ? (drawn >= 3 ? 'Keep clicking to add vertices. Click the green first vertex, press Enter or use Finish to close the shape.' : 'Click the map to place vertices (at least 3).')
    : mode === 'rectangle' ? (hasStart ? 'Click the opposite corner, or release after dragging.' : 'Click a corner (or press and drag) to start the rectangle.')
    : mode === 'circle' ? (hasStart ? 'Click or release at the edge to set the radius.' : 'Click the centre (or press and drag outward) to start the circle.')
    : shape ? 'Drag the square handles to reshape, drag the shape to move it, click a round midpoint to add a vertex. Drawing a new shape replaces this one.'
    : 'Choose a drawing tool, or search for a place and use the current view.';

  return (
    <div className="gf" onKeyDown={onKeyDown}>
      {!readOnly && (
        <>
          <div className="gf-search">
            <label htmlFor="gf-q" className="sr-only">Search for a place</label>
            <input id="gf-q" className="input" type="search" autoComplete="off" placeholder="Search a place (OpenStreetMap)…" value={q}
              onChange={(e) => { setQ(e.target.value); setSearchState('idle'); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); setForced((n) => n + 1); } }} />
            <div className="gf-status" role="status" aria-live="polite">
              {searchState === 'busy' && 'Searching…'}
              {searchState === 'none' && 'No places found.'}
              {searchState === 'error' && 'Place search is unavailable (offline?). You can still draw on the map.'}
            </div>
            {showResults.length > 0 && (
              <ul className="gf-results" aria-label="Search results">
                {showResults.map((p) => <li key={`${p.lat},${p.lng},${p.name}`}><button type="button" onClick={() => pick(p)}>{p.name}</button></li>)}
              </ul>
            )}
          </div>
          <div className="gf-tools" role="toolbar" aria-label="Geofence drawing tools">
            {toolBtn('polygon', 'Polygon', 'Click vertices, then close the shape')}
            {toolBtn('rectangle', 'Rectangle', 'Two opposite corners')}
            {toolBtn('circle', 'Circle', 'Centre, then radius')}
            {mode === 'polygon' && <button type="button" className="btn sm primary" onClick={finishPolygon} disabled={drawn < 3}>Finish shape</button>}
            {mode === 'polygon' && <button type="button" className="btn sm" onClick={addAtCentre} title="Keyboard friendly: pan the map with the arrow keys, then add a vertex at its centre">Add vertex at centre</button>}
            {mode !== 'idle' && <button type="button" className="btn sm" onClick={() => changeMode('idle')}>Cancel drawing</button>}
            <span className="gf-sep" aria-hidden="true" />
            <button type="button" className="btn sm" onClick={undo} disabled={!drawing ? !hist.canUndo : !(drawn || hasStart)} title="Undo (Ctrl+Z)">Undo</button>
            <button type="button" className="btn sm" onClick={hist.redo} disabled={!hist.canRedo || drawing} title="Redo (Ctrl+Shift+Z)">Redo</button>
            <button type="button" className="btn sm" onClick={() => removeVertex(sel!)} disabled={sel === null || shape?.kind !== 'polygon'} title="Delete the selected vertex (Delete key)">Delete vertex</button>
            <button type="button" className="btn sm danger" onClick={() => { changeMode('idle'); hist.commit(null); }} disabled={!shape && !drawing}>Clear</button>
            <span className="gf-sep" aria-hidden="true" />
            <button type="button" className="btn sm" onClick={useView}>Use current view</button>
            <button type="button" className="btn sm" onClick={locate}>Locate me</button>
          </div>
        </>
      )}
      <div className="gf-map">
        <div ref={host} className="gf-canvas" role="application" aria-label="Geofence map. Arrow keys pan, plus and minus zoom." />
        <div className="zoom gf-zoom">
          <button type="button" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>−</button>
          <button type="button" aria-label="Fit to the geofence" onClick={() => fitShape()} disabled={!shape}>⌖</button>
        </div>
        {!tilesOk && <div className="map-hint">Map tiles unreachable. You can still draw on the blank background.</div>}
      </div>
      <p className="gf-help">{help}</p>
      <div className="gf-stats" aria-label="Geofence measurements">
        <div><span>Area</span><b>{info ? fmtArea(info.areaKm2) : '-'}</b></div>
        <div><span>Perimeter</span><b>{info ? `~${fmtLen(info.perimeterKm)}` : '-'}</b></div>
        <div><span>Vertices</span><b>{info ? (shape?.kind === 'circle' && !draft ? '64 (circle)' : info.vertices) : '-'}</b></div>
        <div><span>Shape</span><b>{live ? live.kind : 'none'}{draft ? ' (drawing)' : ''}</b></div>
      </div>
      <div className="gf-msgs" role="status" aria-live="polite">
        {note && <p className="gf-note">{note}</p>}
        {info?.errors.map((m) => <p key={m} className="gf-err">{m}</p>)}
        {info?.warnings.map((m) => <p key={m} className="gf-warn">{m}</p>)}
      </div>
      {!readOnly && <NumericFields shape={shape} onApply={(s) => { if (modeRef.current !== 'idle') changeMode('idle'); hist.commit(s); fitShape(s); }} getCentre={() => mapRef.current?.getCenter() ?? null} />}
    </div>
  );
}

/** Typed alternative to drawing: rectangle bounds or circle centre + radius. */
function NumericFields({ shape, onApply, getCentre }: { shape: Shape | null; onApply: (s: Shape) => void; getCentre: () => L.LatLng | null }) {
  const [r, setR] = useState({ s: '', w: '', n: '', e: '' });
  const [c, setC] = useState({ lat: '', lng: '', rad: '' });
  const [err, setErr] = useState('');
  useEffect(() => {
    if (shape?.kind === 'rectangle') setR({ s: String(+shape.bounds.min_lat.toFixed(5)), w: String(+shape.bounds.min_lng.toFixed(5)), n: String(+shape.bounds.max_lat.toFixed(5)), e: String(+shape.bounds.max_lng.toFixed(5)) });
    if (shape?.kind === 'circle') setC({ lat: String(+shape.lat.toFixed(5)), lng: String(+shape.lng.toFixed(5)), rad: String(Math.round(shape.radius_m)) });
  }, [shape]);
  const num = (v: string) => (v.trim() === '' ? NaN : Number(v));
  const applyRect = () => {
    const [s, w, n, e] = [num(r.s), num(r.w), num(r.n), num(r.e)];
    if (![s, w, n, e].every(Number.isFinite)) return setErr('Enter all four bounds as numbers.');
    if (s < -90 || n > 90 || w < -180 || e > 180) return setErr('Latitude must be within -90..90 and longitude within -180..180.');
    if (s >= n || w >= e) return setErr('South must be below north and west must be left of east.');
    setErr('');
    onApply({ kind: 'rectangle', bounds: { min_lat: s, min_lng: w, max_lat: n, max_lng: e } });
  };
  const applyCircle = () => {
    const [lat, lng, rad] = [num(c.lat), num(c.lng), num(c.rad)];
    if (![lat, lng, rad].every(Number.isFinite)) return setErr('Enter centre latitude, longitude and radius as numbers.');
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return setErr('Centre is out of range.');
    if (rad <= 0 || rad > 1_000_000) return setErr('Radius must be between 1 and 1,000,000 metres.');
    setErr('');
    onApply({ kind: 'circle', lat, lng, radius_m: rad });
  };
  const fillCentre = () => { const m = getCentre(); if (m) setC((x) => ({ ...x, lat: String(+m.lat.toFixed(5)), lng: String(+m.lng.toFixed(5)) })); };
  const f = (id: string, label: string, v: string, set: (x: string) => void) => (
    <div className="field"><label htmlFor={`gf-${id}`}>{label}</label><input id={`gf-${id}`} inputMode="decimal" value={v} onChange={(e) => set(e.target.value)} /></div>
  );
  return (
    <details className="gf-num">
      <summary>Type the numbers instead</summary>
      <div className="gf-num-grid">
        <fieldset>
          <legend>Rectangle by bounds</legend>
          <div className="form-grid" style={{ padding: 0 }}>
            {f('s', 'South latitude', r.s, (x) => setR({ ...r, s: x }))}{f('w', 'West longitude', r.w, (x) => setR({ ...r, w: x }))}
            {f('n', 'North latitude', r.n, (x) => setR({ ...r, n: x }))}{f('e', 'East longitude', r.e, (x) => setR({ ...r, e: x }))}
          </div>
          <button type="button" className="btn sm" onClick={applyRect}>Apply rectangle</button>
        </fieldset>
        <fieldset>
          <legend>Circle by centre and radius</legend>
          <div className="form-grid" style={{ padding: 0 }}>
            {f('clat', 'Centre latitude', c.lat, (x) => setC({ ...c, lat: x }))}{f('clng', 'Centre longitude', c.lng, (x) => setC({ ...c, lng: x }))}
            <div className="full">{f('crad', 'Radius (metres)', c.rad, (x) => setC({ ...c, rad: x }))}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn sm" onClick={fillCentre}>Use map centre</button>
            <button type="button" className="btn sm" onClick={applyCircle}>Apply circle</button>
          </div>
        </fieldset>
      </div>
      {err && <p className="gf-err" role="alert">{err}</p>}
    </details>
  );
}
