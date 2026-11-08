import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as api from '../api/endpoints';
import type { AgentRun, AgentStep, Assignment, Checkin, Deadzone, MeshStats, Responder, Sos, SilentDevice, WsEventAgentStep, WsEventAgentUpdated, WsFrame } from '../api/models';
import { describeFrame, mergeUpdated, removeCases, removeSilent, upsertById, upsertCase, upsertSilent } from '../lib/live';
import { LiveSocket } from '../lib/socket';
import { isStaleFrame, scoreChange } from '../lib/triage';
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
      const prev = qc.getQueryData<Sos[]>(qk.open)?.find((x) => x.id === c.id) ?? qc.getQueryData<Sos>(qk.detail(c.id));
      if (isStaleFrame(prev, c)) break; // an older version arrived late: ignore it
      const change = scoreChange(prev, c);
      if (change) useUi.getState().noteTriageChange(c.id, change);
      qc.setQueryData<Sos[]>(qk.open, (l) => (l ? upsertCase(l, c) : l));
      qc.setQueryData<Sos>(qk.detail(c.id), (d) => (d ? { ...d, ...c } : d));
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
    case 'heartbeat.silent':
      qc.setQueryData<SilentDevice[]>(qk.silent, (l) => (l ? upsertSilent(l, { connectivity: 'lost_contact', ...(f.data as SilentDevice) }) : l));
      void qc.invalidateQueries({ queryKey: qk.mesh });
      break;
    case 'heartbeat.resumed':
      qc.setQueryData<SilentDevice[]>(qk.silent, (l) => (l ? removeSilent(l, (f.data as SilentDevice).device_id) : l));
      void qc.invalidateQueries({ queryKey: qk.mesh });
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
    case 'agent.step': {
      const s = f.data as WsEventAgentStep;
      qc.setQueryData<AgentRun>(qk.agent(s.sos_id), (prev) => {
        if (!prev) return prev;
        const exists = prev.steps.some((x) => x.index === s.index);
        if (exists) return prev;
        const raw = s as unknown as { turn?: number; cached?: boolean };
        const newStep: AgentStep = {
          index: s.index,
          turn: raw.turn ?? 0,
          type: s.type,
          tool: s.tool,
          summary: s.summary,
          ok: s.ok,
          ms: s.ms,
          synthetic: s.synthetic ?? false,
          cached: raw.cached ?? false,
          at: f.ts,
        };
        return { ...prev, steps: [...prev.steps, newStep] };
      });
      break;
    }
    case 'agent.updated': {
      const u = f.data as WsEventAgentUpdated;
      void qc.invalidateQueries({ queryKey: qk.agent(u.sos_id) });
      void qc.invalidateQueries({ queryKey: qk.detail(u.sos_id) });
      void qc.invalidateQueries({ queryKey: qk.open });
      void qc.invalidateQueries({ queryKey: ['cases', 'list'] });
      break;
    }
    case 'responder.updated': {
      const r = f.data as Responder;
      qc.setQueryData<Responder[]>(qk.responders, (list) => (list ? upsertById(list, r) : list));
      break;
    }
  }
}

/** Close the gap after a reconnect: events are not replayed, so refetch what changed since we last heard. */
async function catchUp(qc: QueryClient, since: number) {
  const iso = new Date(since).toISOString();
  const updated = await api.fetchAll((cursor) =>
    api.listSos({ ...buildSosQuery({ tab: 'all', includeResolved: true }), status: undefined, updated_since: iso, cursor }),
  );
  qc.setQueryData<Sos[]>(qk.open, (l) => (l ? mergeUpdated(l, updated) : l));
  for (const k of [qk.silent, qk.deadzones, qk.assignments, qk.responders, ['cases', 'list'], ['checkins'], ['sos']] as const) {
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
