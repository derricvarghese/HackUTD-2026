import { create } from 'zustand';
import { configureClient, request } from '../api/client';
import * as api from '../api/endpoints';
import type { Responder } from '../api/models';

const REFRESH_KEY = 'beacon.refresh';

function readRefresh(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}
function writeRefresh(v: string | null) {
  try {
    if (v) sessionStorage.setItem(REFRESH_KEY, v);
    else sessionStorage.removeItem(REFRESH_KEY);
  } catch {
    /* storage unavailable: session lives in memory only */
  }
}

interface AuthState {
  status: 'booting' | 'anon' | 'authed';
  responder: Responder | null;
  /** In memory only. */
  accessToken: string | null;
  refreshToken: string | null;
  /** epoch ms when the access token expires */
  expiresAt: number;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  restore: () => Promise<void>;
  refresh: () => Promise<boolean>;
  /** A valid access token, refreshing first when it expires within 30 s. */
  validToken: () => Promise<string | null>;
}

let refreshing: Promise<boolean> | null = null;

export const useAuth = create<AuthState>((set, get) => {
  const adopt = (t: api.AuthTokens) => {
    writeRefresh(t.refresh_token);
    set({
      status: 'authed',
      responder: t.responder,
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
      error: null,
    });
  };
  const clear = (error: string | null = null) => {
    writeRefresh(null);
    set({ status: 'anon', responder: null, accessToken: null, refreshToken: null, expiresAt: 0, error });
  };
  return {
    status: 'booting',
    responder: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: 0,
    error: null,
    async login(username, password) {
      adopt(await api.login(username, password));
    },
    async logout() {
      const rt = get().refreshToken;
      clear();
      if (rt) await api.logout(rt).catch(() => undefined);
    },
    async restore() {
      const rt = readRefresh();
      if (!rt) return clear();
      set({ refreshToken: rt });
      if (!(await get().refresh())) clear();
    },
    refresh() {
      // single flight: concurrent 401s share one refresh (refresh tokens rotate)
      refreshing ??= (async () => {
        const rt = get().refreshToken;
        if (!rt) return false;
        try {
          const t = await request<api.AuthTokens>('POST', '/auth/refresh', { body: { refresh_token: rt }, anonymous: true });
          adopt(t);
          return true;
        } catch {
          return false;
        }
      })().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    async validToken() {
      const s = get();
      if (!s.accessToken) return null;
      if (s.expiresAt - Date.now() < 30_000) await s.refresh();
      return get().accessToken;
    },
  };
});

configureClient({
  getToken: () => useAuth.getState().accessToken,
  refresh: () => useAuth.getState().refresh(),
  onSessionLost: () => {
    if (useAuth.getState().status === 'authed') {
      writeRefresh(null);
      useAuth.setState({ status: 'anon', responder: null, accessToken: null, refreshToken: null, error: 'Your session expired. Please sign in again.' });
    }
  },
});

export const useIsAdmin = () => useAuth((s) => s.responder?.role === 'admin');
/** Volunteers can look but not claim or change cases. */
export const useCanAct = () => useAuth((s) => s.responder?.role === 'admin' || s.responder?.role === 'responder');
