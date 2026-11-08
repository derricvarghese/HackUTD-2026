import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ApiError } from './api/client';
import { Shell } from './components/Shell';
import { Toasts } from './components/ui';
import { useAuth } from './state/auth';
import { Assist } from './views/Assist';
import { Checkins } from './views/Checkins';
import { Login } from './views/Login';
import { MapPage } from './views/MapPage';
import { Mesh } from './views/Mesh';
import { Overview } from './views/Overview';
import { Queue } from './views/Queue';
import { Responders } from './views/Responders';
import { Settings } from './views/Settings';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
      },
    },
  });
}

const queryClient = makeQueryClient();

function Gate() {
  const status = useAuth((s) => s.status);
  const restore = useAuth((s) => s.restore);
  useEffect(() => {
    void restore();
  }, [restore]);
  useEffect(() => {
    if (status === 'anon') queryClient.clear();
  }, [status]);
  if (status === 'booting') return <div className="login" aria-busy="true"><span className="sr-only">Loading</span></div>;
  if (status === 'anon') return <><Login /><Toasts /></>;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="map" element={<MapPage />} />
        <Route path="queue" element={<Queue />} />
        <Route path="checkins" element={<Checkins />} />
        <Route path="mesh" element={<Mesh />} />
        <Route path="responders" element={<Responders />} />
        <Route path="assist" element={<Assist />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
