import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as api from '../api/endpoints';
import type { Assignment, Checkin, Deadzone, MeshStats, Sos, SilentDevice, WsFrame } from '../api/models';
import { describeFrame, mergeUpdated, removeCases, removeSilent, upsertCase, upsertSilent } from '../lib/live';
import { LiveSocket } from '../lib/socket';
import { useAuth } from '../state/auth';
import { useUi } from '../state/ui';
import { buildSosQuery } from '../lib/query';
import { qk } from './data';

let heatTimer: ReturnType<typeof setTimeout> | null = null;
/** Heat refetch, trailing-throttled so a burst of case events makes one request and resolved cases fade out within ~1 s. */
export function invalidateHeat(qc: QueryClient, ms = 800) {
  if (heatTimer) return;
  heatTimer = setTimeout(() => {
    heatTimer = null;
    void qc.invalidateQueries({ queryKey: qk.heat });
  }, ms);
}

/** Apply one websocket frame to the query caches. Exported for tests. */
export function applyFrame(qc: QueryClient, f: WsFrame) {
  switch (f.event) {
    case 'sos.created':
    case 'sos.updated':
    case 'sos.silent': {
      const c = f.data as Sos;
      qc.setQueryData<Sos[]>(qk.open, (l) => (l ? upsertCase(l, c) : l));
      void qc.invalidateQueries({ queryKey: ['cases', 'list'] });
      invalidateHeat(qc);
      void qc.invalidateQueries({ queryKey: qk.detail(c.id) });
      break;
    }
    case 'sos.merged': {
      const m = f.data as { primary_id: string; merged_ids: string[] };
      qc.setQueryData<Sos[]>(qk.open, (l) => (l ? removeCases(l, m.merged_ids) : l));
      void qc.invalidateQueries({ queryKey: ['cases'] });
      invalidateHeat(qc);
      void qc.invalidateQueries({ queryKey: qk.detail(m.primary_id) });
      break;
    }
    case 'profile.updated': {
      // Public fields only. The affected cases are refetched (list + detail, which also re-evaluates profile_full access); sos.updated follows from the server.
      const ids = (f.data as { sos_ids?: string[] } | undefined)?.sos_ids ?? [];
      void qc.invalidateQueries({ queryKey: qk.open });
      void qc.invalidateQueries({ queryKey: ['cases', 'list'] });
      for (const id of ids) void qc.invalidateQueries({ queryKey: qk.detail(id) });
      break;
    }
    case 'checkin.sent':
    case 'checkin.responded': {
      const c = f.data as Checkin;
      void qc.invalidateQueries({ queryKey: qk.checkins(c.sos_id) });
      void qc.invalidateQueries({ queryKey: qk.detail(c.sos_id) });
      break;
    }
    case 'assignment.created':
    case 'assignment.updated': {
      const a = f.data as Assignment;
      void qc.invalidateQueries({ queryKey: qk.assignments });
      invalidateHeat(qc);
      void qc.invalidateQueries({ queryKey: qk.responders });
      void qc.invalidateQueries({ queryKey: qk.detail(a.sos_id) });
      void qc.invalidateQueries({ queryKey: ['sos-events', a.sos_id] });
      break;
    }
    case 'offer.created':
    case 'offer.matched':
      void qc.invalidateQueries({ queryKey: qk.offers });
      void qc.invalidateQueries({ queryKey: ['matches'] });
      if (f.event === 'offer.matched') void qc.invalidateQueries({ queryKey: ['sos'] });
      break;
    case 'heartbeat.silent':
      qc.setQueryData<SilentDevice[]>(qk.silent, (l) => (l ? upsertSilent(l, f.data as SilentDevice) : l));
      break;
    case 'heartbeat.resumed':
      qc.setQueryData<SilentDevice[]>(qk.silent, (l) => (l ? removeSilent(l, (f.data as SilentDevice).device_id) : l));
      break;
    case 'deadzones.updated': {
      const d = (f.data as { data?: Deadzone[] } | undefined)?.data;
      if (d) qc.setQueryData(qk.deadzones, d);
      else void qc.invalidateQueries({ queryKey: qk.deadzones });
      invalidateHeat(qc);
      break;
    }
    case 'mesh.stats':
      qc.setQueryData<MeshStats>(qk.mesh, f.data as MeshStats);
      break;
  }
}

/** Close the gap after a reconnect: events are not replayed, so refetch what changed since we last heard. */
async function catchUp(qc: QueryClient, since: number) {
  const iso = new Date(since).toISOString();
  const updated = await api.fetchAll((cursor) =>
    api.listSos({ ...buildSosQuery({ tab: 'all', includeResolved: true }), status: undefined, updated_since: iso, cursor }),
  );
  qc.setQueryData<Sos[]>(qk.open, (l) => (l ? mergeUpdated(l, updated) : l));
  for (const k of [qk.silent, qk.deadzones, qk.assignments, qk.responders, qk.offers, ['cases', 'list'], ['checkins'], ['sos']] as const) {
    void qc.invalidateQueries({ queryKey: k as unknown as readonly unknown[] });
  }
}

/** Opens the websocket for the signed-in responder and keeps caches, feed and the connection indicator up to date. */
export function useLiveUpdates() {
  const qc = useQueryClient();
  const authed = useAuth((s) => s.status === 'authed');

  useEffect(() => {
    if (!authed) return;
    const ui = useUi.getState();
    ui.setConnection('connecting');
    let lastHeard = Date.now();
    const sock = new LiveSocket(() => useAuth.getState().validToken(), {
      onFrame: (f) => {
        lastHeard = Date.now();
        useUi.getState().touch();
        if (f.event === 'pong') return;
        applyFrame(qc, f);
        if (f.event === 'profile.updated') {
          const sel = useUi.getState().selectedId;
          if (sel && ((f.data as { sos_ids?: string[] } | undefined)?.sos_ids ?? []).includes(sel)) useUi.getState().toast('info', 'Profile updated');
        }
        const item = describeFrame(f);
        if (item) useUi.getState().addFeed(item);
      },
      onOpen: (re) => {
        useUi.getState().setConnection('live');
        if (re) void catchUp(qc, lastHeard - 5000).catch(() => undefined);
      },
      onDown: () => useUi.getState().setConnection('reconnecting'),
    });
    sock.start();
    const offline = () => useUi.getState().setConnection('offline');
    window.addEventListener('offline', offline);
    return () => {
      sock.stop();
      window.removeEventListener('offline', offline);
    };
  }, [authed, qc]);
}
