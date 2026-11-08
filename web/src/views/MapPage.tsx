import type { Sos } from '../api/models';
import { EMPTY } from '../lib/empty';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PersonLine } from '../components/Person';
import { MapView, type MapBounds } from '../components/MapView';
import { Empty, Pill, ScoreSq, Seg } from '../components/ui';
import { useDeadzones, useHeat, useOffers, useOpenCases, useResponders, useServerInfo } from '../hooks/data';
import { useNow } from '../hooks/useNow';
import { hopSummary } from '../lib/hops';
import { resolveLocation, shortLocation } from '../lib/privacy';
import { inBounds } from '../lib/stats';
import { caseTitle, shortId } from '../lib/tier';
import { formatAge } from '../lib/time';
import { matchesTab } from '../lib/query';
import { useUi } from '../state/ui';
import { useCanAct } from '../state/auth';
import { useMapActions } from './mapActions';

type F = 'all' | 'critical' | 'silent' | 'assigned';

export function MapPage() {
  const nav = useNavigate();
  const now = useNow();
  const canAct = useCanAct();
  const cases = useOpenCases();
  const responders = useResponders();
  const offers = useOffers();
  const dz = useDeadzones();
  const info = useServerInfo();
  const layers = useUi((s) => s.layers);
  const mapBounds = useUi((s) => s.mapBounds);
  const heat = useHeat(layers.heat, mapBounds);
  const selectedId = useUi((s) => s.selectedId);
  const select = useUi((s) => s.select);
  const [bounds, setBounds] = useState<MapBounds | null>(null);
  const [f, setF] = useState<F>('all');
  const { onDeadzone, pending } = useMapActions();

  const list: Sos[] = cases.data ?? EMPTY;
  const inView = useMemo(
    () => list.filter((c) => { const l = resolveLocation(c); return !bounds || inBounds(l.lat, l.lng, bounds); }),
    [list, bounds],
  );
  const shown = inView.filter((c) => matchesTab(c, f));
  const teams = (responders.data ?? []).filter((r) => r.location && (!bounds || inBounds(r.location.lat, r.location.lng, bounds)));
  const offersIn = (offers.data ?? []).filter((o) => (o.status === 'open' || o.status === 'matched') && (!bounds || inBounds(o.approx_location.lat, o.approx_location.lng, bounds)));
  const zones = (dz.data ?? []).filter((d) => d.status !== 'dismissed');
  const zonesIn = zones.filter((d) => !bounds || inBounds(d.center.lat, d.center.lng, bounds));

  return (
    <div className="view on">
      <div className="mapgrid">
        <div>
          <MapView
            className="big"
            cases={list}
            responders={responders.data}
            offers={offers.data}
            deadzones={dz.data}
            heat={layers.heat ? heat.data : []}
            region={info.data?.event?.region}
            selectedId={selectedId}
            onSelect={select}
            onOpenCase={(id) => { select(id); nav('/queue'); }}
            onBounds={setBounds}
            onDeadzone={onDeadzone}
          />
          <div className="stats mapstats">
            <div className="stat"><div><div className="v" style={{ color: 'var(--red)' }}>{inView.length}</div><div className="l">Open cases in view</div></div></div>
            <div className="stat"><div><div className="v" style={{ color: 'var(--blue)' }}>{teams.length}</div><div className="l">Responders with a position in view</div></div></div>
            <div className="stat"><div><div className="v" style={{ color: 'var(--green)' }}>{offersIn.length}</div><div className="l">Neighbor offers in view</div></div></div>
            <div className="stat"><div><div className="v">{zonesIn.length}</div><div className="l">Dead zones in view</div></div></div>
          </div>
        </div>
        <div className="col">
          <div className="card">
            <div className="card-h"><h2>In view</h2><Pill bg="var(--red-soft)" color="var(--red)">{shown.length} open</Pill></div>
            <Seg<F> label="Filter cases in view" value={f} onChange={setF} options={[{ v: 'all', label: 'All' }, { v: 'critical', label: 'Critical' }, { v: 'silent', label: 'Silent' }, { v: 'assigned', label: 'Assigned' }]} />
            <div className="mlist" style={{ maxHeight: 360, overflow: 'auto' }}>
              {cases.isLoading && <div className="skel" style={{ height: 140, margin: '0 18px 16px' }} />}
              {!cases.isLoading && shown.length === 0 && <Empty>No cases in this part of the map.</Empty>}
              {shown.slice(0, 60).map((c) => (
                <button key={c.id} className="mi click" aria-pressed={c.id === selectedId} onClick={() => select(c.id)} style={c.id === selectedId ? { background: 'var(--blue-soft)' } : undefined}>
                  <ScoreSq c={c} />
                  <div className="grow">
                    <PersonLine profile={c.profile} maxFlags={3} />
                    <span className="csub">{shortId(c.id)} {caseTitle(c, 36).split(' · ').slice(0, 2).join(' · ')}</span>
                    <p>{shortLocation(c)}. {c.silent ? `Silent, last heard ${formatAge(c.last_heard_at, now)}` : c.channel === 'mesh' ? hopSummary(c.hop) : 'App'}{c.assignment ? `. ${c.assignment.responder_name ?? 'Team'} ${c.assignment.status.replace('_', ' ')}` : ''}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h2>Dead zones</h2><Pill bg="#EEF2F7" color="#334155">{zones.length} cell{zones.length === 1 ? '' : 's'}</Pill></div>
            <div className="mlist">
              {dz.isLoading && <div className="skel" style={{ height: 80, margin: '0 18px 16px' }} />}
              {!dz.isLoading && zones.length === 0 && <Empty>No dead zones. Areas that go quiet while neighbours keep reporting show up here.</Empty>}
              {zones.map((d) => (
                <div className="mi" key={d.id}>
                  <span className="sq hatch" />
                  <div className="grow">
                    <b>{d.status === 'being_checked' ? 'Being checked' : 'No reports'}, {d.center.lat.toFixed(2)}, {d.center.lng.toFixed(2)}</b>
                    <p>{d.reason ?? 'No check-ins or reports.'} Last activity {d.last_activity_at ? formatAge(d.last_activity_at, now) : 'never seen'}. {d.neighbor_case_count ?? 0} nearby cases. Radius {Math.round(d.radius_m)} m.</p>
                    {canAct && (
                      <div className="dz">
                        {d.status !== 'being_checked' && <button className="btn sm" disabled={pending} onClick={() => onDeadzone(d, 'being_checked')}>Send a team: mark being checked</button>}
                        {d.status === 'being_checked' && <button className="btn sm" disabled={pending} onClick={() => onDeadzone(d, 'open')}>Reopen</button>}
                        <button className="btn sm" disabled={pending} onClick={() => onDeadzone(d, 'dismissed')}>Dismiss</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
