import { useMemo, useRef, useState, type FormEvent } from 'react';
import * as api from '../api/endpoints';
import { ApiError } from '../api/client';
import type { AppEvent } from '../api/models';
import { errorMessage, qk, useAction } from '../hooks/data';
import { analyseShape, regionToShape, shapeToRegion } from '../lib/geofenceShape';
import { useShapeHistory } from '../lib/shapeHistory';
import { GeofenceEditor, type GeofenceEditorHandle } from './GeofenceEditor';
import { Modal } from './ui';

const mins = (s: number) => (s % 60 === 0 ? `${s / 60} min` : `${s} s`);

/**
 * Create a disaster event or edit/view an existing one. The geofence is drawn on a map (GeofenceEditor);
 * the client sends the polygon plus the bounding box it computes from it (the server recomputes the box anyway).
 */
export function EventDialog({ event, onClose }: { event?: AppEvent; onClose: () => void }) {
  const editing = !!event;
  const readOnly = !!event && event.status !== 'active';
  const [name, setName] = useState(event?.name ?? '');
  const [retention, setRetention] = useState(String(event?.retention_days ?? 7));
  const [hb, setHb] = useState(String(event?.heartbeat_interval_seconds ?? 300));
  const [silence, setSilence] = useState(String(event?.silence_threshold_seconds ?? 1200));
  const [err, setErr] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const hist = useShapeHistory(useMemo(() => regionToShape(event?.region), [event?.region]));
  const editor = useRef<GeofenceEditorHandle>(null);

  const info = useMemo(() => analyseShape(hist.shape), [hist.shape]);
  const hbN = Number(hb), siN = Number(silence), retN = Number(retention);
  const problems: string[] = [];
  if (!name.trim()) problems.push('Give the event a name.');
  if (!Number.isInteger(retN) || retN < 1 || retN > 365) problems.push('Retention must be 1 to 365 days.');
  // an untouched value on an existing event is left alone (a DEMO_MODE server reports accelerated timers below the contract minimums)
  const hbSame = editing && hbN === event.heartbeat_interval_seconds;
  const siSame = editing && siN === event.silence_threshold_seconds;
  if (!hbSame && (!Number.isInteger(hbN) || hbN < 30)) problems.push('Heartbeat interval must be at least 30 seconds.');
  if (!siSame && (!Number.isInteger(siN) || siN < 60)) problems.push('Silence threshold must be at least 60 seconds.');
  else if (!hbSame && !siSame && Number.isInteger(hbN) && siN < hbN * 2) problems.push('Silence threshold should be at least twice the heartbeat interval, or phones are flagged between two normal heartbeats.');
  if (!hist.shape) problems.push('Draw the geofence on the map.');
  if (info?.errors.length) problems.push(...info.errors);
  if (drawing) problems.push('Finish or cancel the shape you are drawing.');

  const save = useAction(
    () => {
      const body = {
        name: name.trim(), retention_days: retN,
        ...(hbSame ? {} : { heartbeat_interval_seconds: hbN }), ...(siSame ? {} : { silence_threshold_seconds: siN }),
        region: shapeToRegion(hist.shape!),
      };
      return editing ? api.updateEvent(event.id, body) : api.createEvent(body);
    },
    {
      success: editing ? 'Event updated' : 'Event created',
      invalidate: (qc) => { void qc.invalidateQueries({ queryKey: qk.events }); void qc.invalidateQueries({ queryKey: qk.serverInfo }); },
      onError: (e) => { setErr(e instanceof ApiError && e.status === 409 ? 'Another event is already active, or this one is no longer active.' : errorMessage(e)); return true; },
    },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!readOnly && !problems.length) save.mutate(undefined, { onSuccess: onClose });
  };
  const title = readOnly ? `Event area: ${event.name}` : editing ? 'Edit event and geofence' : 'Create a disaster event';

  return (
    <Modal title={title} onClose={onClose} wide escapeGuard={() => editor.current?.cancelDraw() ?? false}>
      <form onSubmit={submit} noValidate className="evd">
        {!readOnly && (
          <div className="form-grid evd-fields" style={{ padding: 0 }}>
            <div className="field full"><label htmlFor="ev-name">Name</label><input id="ev-name" value={name} onChange={(e) => setName(e.target.value)} required data-autofocus placeholder="Flood Event - Riverside Region" /></div>
            <div className="field"><label htmlFor="ev-ret">Keep personal data for (days after closing)</label><input id="ev-ret" type="number" min={1} max={365} value={retention} onChange={(e) => setRetention(e.target.value)} aria-describedby="ev-ret-h" /><span className="hint" id="ev-ret-h">Exact locations and messages are erased after this long.</span></div>
            <div className="field"><label htmlFor="ev-hb">Heartbeat interval (seconds)</label><input id="ev-hb" type="number" min={30} value={hb} onChange={(e) => setHb(e.target.value)} aria-describedby="ev-hb-h" /><span className="hint" id="ev-hb-h">How often phones report in{Number.isInteger(hbN) && hbN >= 30 ? ` (${mins(hbN)})` : ''}. Shorter drains batteries faster.</span></div>
            <div className="field"><label htmlFor="ev-si">Silence threshold (seconds)</label><input id="ev-si" type="number" min={60} value={silence} onChange={(e) => setSilence(e.target.value)} aria-describedby="ev-si-h" /><span className="hint" id="ev-si-h">A phone with no heartbeat for this long is flagged silent{Number.isInteger(siN) && siN >= 60 ? ` (${mins(siN)})` : ''}.</span></div>
          </div>
        )}
        <h4 className="gf-h4">Geofence</h4>
        <p className="gf-lead">{readOnly ? 'The area this event covered.' : 'Draw the area this event covers. Dead zones are only reported inside it and the map fits to it. Reports from just outside are still accepted.'}</p>
        <GeofenceEditor ref={editor} hist={hist} readOnly={readOnly} onDrawingChange={setDrawing} />
        {err && <div className="form-err" role="alert" style={{ padding: '8px 0 0' }}>{err}</div>}
        {!readOnly && problems.length > 0 && <ul className="gf-problems" aria-label="Before you can save">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <div className="acts" style={{ padding: '14px 0 0' }}>
          <button type="button" className="btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
          {!readOnly && <button className="btn primary" type="submit" disabled={problems.length > 0 || save.isPending}>{save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create event'}</button>}
        </div>
      </form>
    </Modal>
  );
}
