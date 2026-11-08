import type { Sos } from '../api/models';
import { EMPTY } from '../lib/empty';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FeedCard, MeshHealthCard, OffersCard } from '../components/cards';
import { IcHelmet, IcLayers, IcOpenSos, IcSilent, IcWarn } from '../components/icons';
import { MapView } from '../components/MapView';
import { QueueList, mergeQueue, queueDevices } from '../components/QueueCard';
import { ErrorBox, StatCard, Tabs } from '../components/ui';
import { useDeadzones, useHeat, useMeshStats, useOffers, useOpenCases, useResponders, useServerInfo, useSilent } from '../hooks/data';
import { useNow } from '../hooks/useNow';
import type { QueueTab } from '../lib/query';
import { matchesTab } from '../lib/query';
import { overviewStats } from '../lib/stats';
import { useUi } from '../state/ui';
import { useMapActions } from './mapActions';

export function Overview() {
  const nav = useNavigate();
  const now = useNow();
  const cases = useOpenCases();
  const responders = useResponders();
  const silentDevs = useSilent();
  const offers = useOffers();
  const mesh = useMeshStats();
  const info = useServerInfo();
  const dz = useDeadzones();
  const layers = useUi((s) => s.layers);
  const mapBounds = useUi((s) => s.mapBounds);
  const heat = useHeat(layers.heat, mapBounds);
  const selectedId = useUi((s) => s.selectedId);
  const select = useUi((s) => s.select);
  const [tab, setTab] = useState<QueueTab>('all');
  const { onDeadzone } = useMapActions();

  const list: Sos[] = cases.data ?? EMPTY;
  const stats = useMemo(() => overviewStats(list, responders.data ?? [], now), [list, responders.data, now]);
  const devices = queueDevices(silentDevs.data);
  const items = useMemo(() => mergeQueue(list, devices, tab), [list, devices, tab]);
  const count = (t: QueueTab) => list.filter((c) => matchesTab(c, t)).length + (t === 'all' || t === 'silent' ? devices.length : 0);
  const openCase = (id: string) => { select(id); nav('/queue'); };

  return (
    <div className="view on">
      <section className="stats" aria-label="Key numbers">
        <StatCard icon={<IcOpenSos />} iconBg="var(--blue-soft)" value={stats.open} label="Open SOS Cases" loading={cases.isLoading} delta={`▲ +${stats.openNewHour}/h`} deltaBg="var(--blue-soft)" deltaColor="var(--blue)" onClick={() => nav('/queue')} />
        <StatCard tone="red" icon={<IcWarn />} iconBg="var(--red-soft)" value={stats.critical} label="Critical (score 80+)" loading={cases.isLoading} delta={`▲ +${stats.criticalNewHour}/h`} deltaBg="var(--red-soft)" deltaColor="var(--red)" onClick={() => nav('/queue')} />
        <StatCard tone="amber" icon={<IcSilent />} iconBg="var(--amber-soft)" value={stats.silent + devices.length} label="Went Silent · priority ↑" loading={cases.isLoading} delta={`▲ +${stats.silentNewHour}/h`} deltaBg="var(--amber-soft)" deltaColor="#B45309" onClick={() => nav('/checkins')} />
        <StatCard icon={<IcHelmet />} iconBg="var(--green-soft)" value={stats.deployed} label="Responders Deployed" loading={responders.isLoading} delta={`${stats.available} free`} deltaBg="var(--green-soft)" deltaColor="var(--green)" onClick={() => nav('/responders')} />
      </section>

      <section className="row">
        <MapView
          cases={list}
          responders={responders.data}
          offers={offers.data}
          deadzones={dz.data}
          heat={layers.heat ? heat.data : []}
          region={info.data?.event?.region}
          selectedId={selectedId}
          onSelect={select}
          onOpenCase={openCase}
          onDeadzone={onDeadzone}
        />
        <div className="card">
          <div className="card-h">
            <IcLayers />
            <h2>Triage Queue <span className="count-red">({count('all')})</span></h2>
            <Link className="more" to="/queue">View all →</Link>
          </div>
          <Tabs<QueueTab>
              label="Queue filter"
              value={tab}
              onChange={setTab}
              options={[
                { v: 'all', label: `All (${count('all')})` },
                { v: 'critical', label: `Critical (${count('critical')})` },
                { v: 'high', label: `High (${count('high')})` },
                { v: 'silent', label: `Silent (${count('silent')})` },
              ]}
          />
          {cases.isError ? <ErrorBox error={cases.error} onRetry={() => void cases.refetch()} /> : <QueueList items={items} selectedId={selectedId} onSelect={select} onOpen={openCase} now={now} loading={cases.isLoading} />}
        </div>
      </section>

      <section className="bottom">
        <FeedCard cases={list} loading={cases.isLoading} />
        <MeshHealthCard stats={mesh.data} loading={mesh.isLoading} limits={info.data?.hop_limits} />
        <OffersCard offers={offers.data} loading={offers.isLoading} />
      </section>
    </div>
  );
}
