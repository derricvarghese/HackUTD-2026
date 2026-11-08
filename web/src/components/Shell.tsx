import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLiveUpdates } from '../hooks/live';
import { useOpenCases, useServerInfo } from '../hooks/data';
import { latestEscalation } from '../lib/escalation';
import { useAuth } from '../state/auth';
import { useUi } from '../state/ui';
import { IcCheck, IcCog, IcHeart, IcHome, IcList, IcMenu, IcMesh, IcPeople, IcPin, IcWaves, LogoMark } from './icons';
import { Toasts } from './ui';

const NAV = [
  { to: '/', key: 'overview', label: 'Overview', icon: IcHome, title: 'Emergency Command Center', sub: 'Beacon Disaster Response · Phones pass SOS hand to hand until one reaches the internet' },
  { to: '/map', key: 'map', label: 'Incident Map', icon: IcPin, title: 'Incident Map', sub: 'Every open case, team, neighbour offer and dead zone in the event region' },
  { to: '/queue', key: 'queue', label: 'Triage Queue', icon: IcList, title: 'Triage Queue', sub: 'Ranked by urgency. Rules set the floor, the AI reads the message, silence pushes a case up' },
  { to: '/checkins', key: 'checkins', label: 'Check-ins', icon: IcCheck, title: 'Check-ins', sub: 'Who has answered, who has not, and which phones went quiet' },
  { to: '/mesh', key: 'mesh', label: 'Mesh Network', icon: IcMesh, title: 'Mesh Network', sub: 'How SOS messages are moving phone to phone until one reaches signal' },
  { to: '/responders', key: 'responders', label: 'Responders', icon: IcPeople, title: 'Responders', sub: 'Teams in the field, what they can do and where they are headed' },
  { to: '/assist', key: 'assist', label: 'Neighbor Assist', icon: IcHeart, title: 'Neighbor Assist', sub: 'People marked safe offering help, matched to requests nearby' },
  { to: '/settings', key: 'settings', label: 'Events & Settings', icon: IcCog, title: 'Events & Settings', sub: 'Disaster events, data retention and demo tools' },
] as const;

function Sidebar() {
  const open = useOpenCases();
  const nav = useNavigate();
  const select = useUi((s) => s.select);
  const navOpen = useUi((s) => s.navOpen);
  const count = open.data?.length;
  const esc = open.data ? latestEscalation(open.data) : null;
  return (
    <aside className={`side${navOpen ? ' open' : ''}`} aria-label="Primary">
      <div className="logo">
        <LogoMark />
        <b>beacon</b>
      </div>
      <div className="tag">
        DISASTER RESPONSE
        <br />
        OFFLINE MESH · AI TRIAGE
      </div>
      <nav className="nav" aria-label="Views">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'on' : '')} title={n.label} onClick={() => useUi.setState({ navOpen: false })}>
            <n.icon />
            <span className="t">{n.label}</span>
            {n.key === 'queue' && count !== undefined && <span className={`ct${count ? '' : ' zero'}`} aria-label={`${count} open cases`}>{count}</span>}
          </NavLink>
        ))}
      </nav>
      {esc ? (
        <button className="assist" onClick={() => { select(esc.caseId); nav('/queue'); }}>
          <span className="ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={esc.kind === 'silent' ? '#C4B5FD' : '#FCA5A5'} strokeWidth="2" strokeLinecap="round"><path d="M12 3L2 21h20z" /><path d="M12 10v5M12 18v.5" /></svg></span>
          <div><small>LATEST ESCALATION</small><p>{esc.text}</p></div>
        </button>
      ) : (
        <div className="assist idle"><span className="ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#86EFAC" strokeWidth="2" strokeLinecap="round"><path d="M5 12l4 4 10-10" /></svg></span><div><small>LATEST ESCALATION</small><p>{open.isLoading ? 'Loading…' : 'Nothing escalated right now'}</p></div></div>
      )}
    </aside>
  );
}

function Header({ title, sub }: { title: string; sub: string }) {
  const info = useServerInfo();
  const conn = useUi((s) => s.connection);
  const me = useAuth((s) => s.responder);
  const logout = useAuth((s) => s.logout);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menu]);
  const ev = info.data?.event;
  const initials = (me?.name ?? me?.username ?? '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const connLabel = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…', offline: 'Offline' }[conn];
  return (
    <header>
      <button className="icon-btn nav-toggle" aria-label="Open navigation" onClick={() => useUi.setState((s) => ({ navOpen: !s.navOpen }))}><IcMenu width={20} height={20} /></button>
      <div className="title">
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      <div className="hdr-r">
        <div className={`event${ev ? '' : ' none'}`}>
          <IcWaves />
          {ev ? ev.name : info.isLoading ? 'Loading event…' : 'No active event'}
          {ev && (
            <span className="live"><span className="dot" />ACTIVE</span>
          )}
        </div>
        <div className={`conn ${conn}`} role="status" aria-live="polite" title="Realtime connection to the Beacon server">
          <i />
          {connLabel}
        </div>
        <div className="usermenu" ref={ref}>
          <button className="avatar" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><span className="sr-only">Account menu for {me?.name ?? 'you'} </span>{initials}</button>
          {menu && (
            <div className="pop-menu" role="menu">
              <b>{me?.name}</b>
              <span className="muted">@{me?.username} · {me?.role}</span>
              <button className="btn" role="menuitem" onClick={() => void logout()}>Sign out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export function Shell() {
  useLiveUpdates();
  const loc = useLocation();
  const cur = NAV.find((n) => (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to))) ?? NAV[0];
  useEffect(() => {
    document.title = cur.key === 'overview' ? 'Beacon - Emergency Command Center' : `${cur.title} - Beacon`;
  }, [cur]);
  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <Sidebar />
      <main id="main" tabIndex={-1}>
        <Header title={cur.title} sub={cur.sub} />
        <Outlet />
      </main>
      <Toasts />
    </div>
  );
}
