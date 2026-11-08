import { useEffect, useState } from 'react';
import * as api from '../api/endpoints';
import { ApiError } from '../api/client';
import type { AppEvent } from '../api/models';
import { ConfirmDialog, Empty, ErrorBox, Pill, Seg } from '../components/ui';
import { qk, useAction, useEvents, useServerInfo } from '../hooks/data';
import { formatDateTime } from '../lib/time';
import { regionBox, regionCenter } from '../lib/region';
import { describeRegion } from '../lib/geofenceShape';
import { EventDialog } from '../components/EventDialog';
import { GeofenceMini } from '../components/GeofenceMini';
import { useAuth, useCanAct, useIsAdmin } from '../state/auth';
import { useUi } from '../state/ui';

const STATUS_PILL: Record<AppEvent['status'], [string, string]> = { active: ['var(--green-soft)', 'var(--green)'], closed: ['var(--amber-soft)', '#B45309'], purged: ['#EEF2F7', '#475569'] };

type Pending = { kind: 'close' | 'purge' | 'delete'; ev: AppEvent };

function EventsCard() {
  const isAdmin = useIsAdmin();
  const events = useEvents();
  const [dialog, setDialog] = useState<{ event?: AppEvent } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const inv = (qc: import('@tanstack/react-query').QueryClient) => { void qc.invalidateQueries({ queryKey: qk.events }); void qc.invalidateQueries({ queryKey: qk.serverInfo }); void qc.invalidateQueries({ queryKey: ['cases'] }); };
  const close = useAction((id: string) => api.closeEvent(id), { success: 'Event closed. Detectors stopped; retention clock started.', invalidate: inv });
  const purge = useAction((id: string) => api.purgeEvent(id), { success: (r) => `Purged ${r.purged_cases ?? 0} cases and ${r.purged_voice_notes ?? 0} voice notes`, invalidate: inv });
  const del = useAction((id: string) => api.deleteEvent(id), { success: 'Event deleted', invalidate: inv });
  const busy = close.isPending || purge.isPending || del.isPending;
  const run = () => {
    if (!pending) return;
    const m = pending.kind === 'close' ? close : pending.kind === 'purge' ? purge : del;
    m.mutate(pending.ev.id, { onSuccess: () => setPending(null), onError: () => setPending(null) });
  };
  const text: Record<Pending['kind'], { title: string; body: string; label: string; danger: boolean }> = {
    close: { title: 'Close this event?', body: 'Check-ins and silence detection stop and the retention countdown starts. Cases stay visible until the data is purged.', label: 'Close event', danger: false },
    purge: { title: 'Purge personal data now?', body: 'Exact locations, message text, voice notes, device links and heartbeats are permanently erased. Counts, scores and hop statistics are kept. This cannot be undone.', label: 'Purge data', danger: true },
    delete: { title: 'Delete this event?', body: 'The event record is removed. Only possible when it has no data left to protect. This cannot be undone.', label: 'Delete event', danger: true },
  };
  return (
    <div className="card">
      <div className="card-h">
        <h2>Disaster events</h2>
        <span style={{ marginLeft: 'auto' }}>{isAdmin && <button className="btn primary" onClick={() => setDialog({})}>New event</button>}</span>
      </div>
      {events.isError && <ErrorBox error={events.error} onRetry={() => void events.refetch()} />}
      <div className="tbl-wrap">
        <table className="tbl" aria-label="Events">
          <thead><tr><th>Event</th><th>Area</th><th>Status</th><th>Cases</th><th>Created</th><th>Data purge</th>{isAdmin && <th><span className="sr-only">Actions</span></th>}</tr></thead>
          <tbody>
            {events.isLoading && <tr><td colSpan={7}><div className="skel" style={{ height: 34 }} /></td></tr>}
            {(events.data ?? []).map((e) => (
              <tr key={e.id}>
                <td><b>{e.name}</b>{e.synthetic && <p>Synthetic demo data</p>}</td>
                <td className="gf-cell">
                  <GeofenceMini region={e.region} />
                  <div>
                    {(() => { const d = describeRegion(e.region); return d ? <><b>{d.area}</b><p title="south-west to north-east corner of the bounding box">{d.bounds}</p></> : <p>No area set</p>; })()}
                    <button className="btn sm" onClick={() => setDialog({ event: e })}>{isAdmin && e.status === 'active' ? 'Edit area' : 'View area'}</button>
                  </div>
                </td>
                <td><Pill bg={STATUS_PILL[e.status][0]} color={STATUS_PILL[e.status][1]}>{e.status}</Pill></td>
                <td>{e.open_case_count ?? 0} open<p>{e.case_count ?? 0} total</p></td>
                <td>{formatDateTime(e.created_at)}{e.closed_at && <p>Closed {formatDateTime(e.closed_at)}</p>}</td>
                <td>{e.purged_at ? `Purged ${formatDateTime(e.purged_at)}` : e.purge_at ? `Scheduled ${formatDateTime(e.purge_at)}` : e.status === 'active' ? 'After closing' : '-'}</td>
                {isAdmin && (
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {e.status === 'active' && <button className="btn sm" onClick={() => setPending({ kind: 'close', ev: e })}>Close</button>}{' '}
                    {e.status === 'closed' && <button className="btn sm danger" onClick={() => setPending({ kind: 'purge', ev: e })}>Purge now</button>}{' '}
                    {e.status !== 'active' && <button className="btn sm" onClick={() => setPending({ kind: 'delete', ev: e })}>Delete</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!events.isLoading && !events.data?.length && <Empty>No events yet. {isAdmin ? 'Create one to start receiving cases.' : 'An admin has to create one.'}</Empty>}
      {dialog && <EventDialog event={dialog.event} onClose={() => setDialog(null)} />}
      {pending && <ConfirmDialog title={text[pending.kind].title} danger={text[pending.kind].danger} confirmLabel={text[pending.kind].label} busy={busy} onClose={() => setPending(null)} onConfirm={run}
        body={<><p><b>{pending.ev.name}</b></p><p style={{ marginTop: 6 }}>{text[pending.kind].body}</p></>} />}
    </div>
  );
}

function DemoCard() {
  const info = useServerInfo();
  const demo = useUi((s) => s.demo);
  const setDemo = useUi((s) => s.setDemo);
  const canAct = useCanAct();
  const [count, setCount] = useState('40');
  const [radius, setRadius] = useState('5');
  const [hops, setHops] = useState('3');
  const [confirmClear, setConfirmClear] = useState(false);
  const ev = info.data?.event;
  const box = regionBox(ev?.region);
  const center = box ? regionCenter(box) : null;
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const c = { lat: lat !== '' ? Number(lat) : (center?.lat ?? 32.78), lng: lng !== '' ? Number(lng) : (center?.lng ?? -96.8) };

  // The demo endpoints answer 404 unless the server runs with DEMO_MODE. Probe once with a body that cannot create anything.
  const hasEvent = info.isSuccess ? !!info.data?.event : null;
  useEffect(() => {
    if (demo !== null || hasEvent === null) return;
    api.probeDemo(hasEvent).then((v) => v !== null && setDemo(v)).catch(() => undefined);
  }, [demo, hasEvent, setDemo]);

  const onErr = (e: unknown) => { if (e instanceof ApiError && e.status === 404) { setDemo(false); return false; } return false; };
  const inv = (qc: import('@tanstack/react-query').QueryClient) => { void qc.invalidateQueries({ queryKey: ['cases'] }); void qc.invalidateQueries({ queryKey: qk.events }); void qc.invalidateQueries({ queryKey: qk.serverInfo }); void qc.invalidateQueries({ queryKey: qk.silent }); void qc.invalidateQueries({ queryKey: qk.mesh }); };
  const seed = useAction(() => api.seedDemo({ center_lat: c.lat, center_lng: c.lng, radius_km: Number(radius) || 5, count: Math.min(500, Number(count) || 40) }), { success: (r) => `Created ${r.created} synthetic cases`, invalidate: inv, onError: onErr });
  const sim = useAction((category: 'trapped' | 'injured' | 'need_water_meds') => api.simulateRelay({ lat: c.lat, lng: c.lng, category, hops: Number(hops) || 3, text: category === 'trapped' ? 'Simulated: trapped upstairs, water rising' : category === 'injured' ? 'Simulated: injured, cannot walk' : 'Simulated: out of water and medicine' }), { success: 'Simulated relay delivered', invalidate: inv, onError: onErr });
  const clear = useAction(() => api.clearDemo(), { success: 'Synthetic data cleared', invalidate: inv, onError: onErr });

  if (demo === null && info.isLoading) return <div className="card"><div className="card-h"><h2>Demo tools</h2></div><div className="empty">Checking whether the server is in demo mode…</div></div>;
  if (demo === false) return <div className="card"><div className="card-h"><h2>Demo tools</h2></div><div className="empty">This server is not running in DEMO_MODE, so seeding and relay simulation are unavailable.</div></div>;
  return (
    <div className="card">
      <div className="card-h"><h2>Demo tools</h2><Pill bg="var(--amber-soft)" color="#B45309">{demo ? 'DEMO_MODE' : 'availability unknown'}</Pill></div>
      <p className="sub">Create synthetic cases clustered around a point, or inject one relayed SOS with a fabricated hop path. Everything created here is flagged synthetic and can be cleared in one click.</p>
      <div className="form-grid">
        <div className="field"><label htmlFor="d-lat">Centre latitude</label><input id="d-lat" inputMode="decimal" value={lat} placeholder={String(c.lat.toFixed(4))} onChange={(e) => setLat(e.target.value)} /></div>
        <div className="field"><label htmlFor="d-lng">Centre longitude</label><input id="d-lng" inputMode="decimal" value={lng} placeholder={String(c.lng.toFixed(4))} onChange={(e) => setLng(e.target.value)} /></div>
        <div className="field"><label htmlFor="d-count">Cases to seed (max 500)</label><input id="d-count" type="number" min={1} max={500} value={count} onChange={(e) => setCount(e.target.value)} /></div>
        <div className="field"><label htmlFor="d-rad">Radius (km)</label><input id="d-rad" type="number" min={0.5} step={0.5} value={radius} onChange={(e) => setRadius(e.target.value)} /></div>
        <div className="field"><label htmlFor="d-hops">Hops for simulated relay (0-10)</label><input id="d-hops" type="number" min={0} max={10} value={hops} onChange={(e) => setHops(e.target.value)} /></div>
      </div>
      {canAct ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 18px 18px' }}>
          <button className="btn primary" disabled={seed.isPending} onClick={() => seed.mutate(undefined)}>{seed.isPending ? 'Seeding…' : 'Seed synthetic data'}</button>
          <button className="btn" disabled={sim.isPending} onClick={() => sim.mutate('trapped')}>Simulate relay: trapped</button>
          <button className="btn" disabled={sim.isPending} onClick={() => sim.mutate('injured')}>Simulate relay: injured</button>
          <button className="btn" disabled={sim.isPending} onClick={() => sim.mutate('need_water_meds')}>Simulate relay: water / meds</button>
          <button className="btn danger" disabled={clear.isPending} onClick={() => setConfirmClear(true)}>Clear synthetic data</button>
        </div>
      ) : <p className="note" style={{ padding: '0 18px 18px' }}>Volunteers cannot run demo tools.</p>}
      {confirmClear && <ConfirmDialog title="Clear all synthetic data?" danger confirmLabel="Clear" busy={clear.isPending} body="Removes every synthetic case, device and heartbeat. Real data is not touched." onClose={() => setConfirmClear(false)} onConfirm={() => clear.mutate(undefined, { onSettled: () => setConfirmClear(false) })} />}
    </div>
  );
}

function PreferencesCard() {
  const units = useUi((s) => s.units);
  const setUnits = useUi((s) => s.setUnits);
  return (
    <div className="card">
      <div className="card-h"><h2>Display and Units</h2></div>
      <div style={{ padding: '14px 18px' }}>
        <label style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
          Distance units preference
        </label>
        <Seg<'auto' | 'metric' | 'imperial'>
          label="Distance units"
          value={units}
          onChange={setUnits}
          options={[
            { v: 'auto', label: 'Automatic (system)' },
            { v: 'metric', label: 'Metric (km, m)' },
            { v: 'imperial', label: 'Imperial (mi, ft)' },
          ]}
        />
        <p className="note" style={{ marginTop: 10 }}>
          Controls how search radii, travel distances, and facility distances are formatted across the dashboard.
        </p>
      </div>
    </div>
  );
}

export function Settings() {
  const me = useAuth((s) => s.responder);
  const info = useServerInfo();
  return (
    <div className="view on">
      <EventsCard />
      <div className="two">
        <DemoCard />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <PreferencesCard />
          <div className="card">
            <div className="card-h"><h2>Server and session</h2></div>
            <div className="rules">
              <div><span>Signed in as</span><b>{me?.name} (@{me?.username}, {me?.role})</b></div>
              <div><span>Active event</span><b>{info.data?.event?.name ?? 'None'}</b></div>
              <div><span>Check-in interval</span><b>{info.data?.checkin_interval_seconds ? `${info.data.checkin_interval_seconds} s` : '-'}</b></div>
              <div><span>Heartbeat interval</span><b>{info.data?.heartbeat_interval_seconds ? `${info.data.heartbeat_interval_seconds} s` : '-'}</b></div>
              <div><span>Silence threshold</span><b>{info.data?.silence_threshold_seconds ? `${info.data.silence_threshold_seconds} s` : '-'}</b></div>
              <div><span>Gateway batch size</span><b>{info.data?.gateway_upload_max_batch ?? '-'}</b></div>
              <div><span>Profile required at onboarding</span><b>{info.data?.profile_required === undefined ? '-' : info.data.profile_required ? 'Yes (user may skip explicitly)' : 'No'}</b></div>
              <div><span>Profile consent version</span><b>{info.data?.profile_consent_version ?? '-'}</b></div>
            </div>
            <p className="note" style={{ padding: '0 18px 16px' }}>Exact victim locations are only shown to the assigned responder and admins. Everyone else sees an approximate area. Names, age ranges and coarse flags are visible to every dashboard user; medical and contact details only to the assigned responder and admins. Profile settings here are read-only and come from the server configuration.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
