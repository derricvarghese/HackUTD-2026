import { useId } from 'react';
import { regionToShape, shapeRing } from '../lib/geofenceShape';

/** Tiny static outline of an event area (no tiles, no network): the ring projected with an equirectangular fit. */
export function GeofenceMini({ region, width = 112, height = 72 }: { region: unknown; width?: number; height?: number }) {
  const id = useId();
  const shape = regionToShape(region);
  if (!shape) return <span className="gf-mini none" style={{ width, height }}>No area</span>;
  const ring = shapeRing(shape);
  const midLat = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  const k = Math.cos((midLat * Math.PI) / 180);
  const xs = ring.map((p) => p[0] * k), ys = ring.map((p) => -p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 6;
  const sc = Math.min((width - 2 * pad) / Math.max(maxX - minX, 1e-9), (height - 2 * pad) / Math.max(maxY - minY, 1e-9));
  const ox = (width - (maxX - minX) * sc) / 2, oy = (height - (maxY - minY) * sc) / 2;
  const pts = ring.map((_, i) => `${((xs[i] - minX) * sc + ox).toFixed(1)},${((ys[i] - minY) * sc + oy).toFixed(1)}`).join(' ');
  return (
    <svg className="gf-mini" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={id}>
      <title id={id}>Outline of the event area</title>
      <polygon points={pts} fill="rgba(14,116,144,.15)" stroke="#0E7490" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
