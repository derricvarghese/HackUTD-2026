import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useLiveUpdates } from '../hooks/live';
import { useOpenCases, useServerInfo } from '../hooks/data';
import { latestEscalation } from '../lib/escalation';
import { useAuth } from '../state/auth';
import { useUi } from '../state/ui';
import { IcCheck, IcCog, IcHeart, IcHome, IcList, IcMenu, IcMesh, IcPeople, LogoMark } from './icons';
import { Toasts } from './ui';
import { CasePopover } from './CasePopover';

const NAV = [
  { to: '/', key: 'overview', label: 'Overview', icon: IcHome, title: 'Emergency Command Center', sub: 'Beacon Disaster Response · Phones pass SOS hand to hand until one reaches the internet' },
  { to: '/queue', key: 'queue', label: 'Triage Queue', icon: IcList, title: 'Triage Queue', sub: 'Ranked by urgency. Rules set the floor, the AI reads the message, silence pushes a case up' },
  { to: '/checkins', key: 'checkins', label: 'Check-ins', icon: IcCheck, title: 'Check-ins', sub: 'Who has answered, who has not, and which phones went quiet' },
  { to: '/mesh', key: 'mesh', label: 'Mesh Network', icon: IcMesh, title: 'Mesh Network', sub: 'How SOS messages are moving phone to phone until one reaches signal' },
  { to: '/responders', key: 'responders', label: 'Responders', icon: IcPeople, title: 'Responders', sub: 'Teams in the field, what they can do and where they are headed' },
  { to: '/assist', key: 'assist', label: 'Neighbor Assist', icon: IcHeart, title: 'Neighbor Assist', sub: 'People marked safe offering help, matched to requests nearby' },
  { to: '/settings', key: 'settings', label: 'Events & Settings', icon: IcCog, title: 'Events & Settings', sub: 'Disaster events, data retention and demo tools' },
] as const;

function Sidebar() {
  const open = useOpenCases();
  const info = useServerInfo();
  const me = useAuth((s) => s.responder);
  const logout = useAuth((s) => s.logout);
  const select = useUi((s) => s.select);
  const navOpen = useUi((s) => s.navOpen);
  const count = open.data?.filter((c) => c.category !== 'safe' && c.score >= 20).length;
  const esc = open.data ? latestEscalation(open.data) : null;
  const ev = info.data?.event;
  const initials = (me?.name ?? me?.username ?? '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <aside className={`side${navOpen ? ' open' : ''}`} aria-label="Primary">
      <div className="logo">
        <LogoMark />
        <b>beacon</b>
      </div>

      <div className={`side-event${ev ? '' : ' none'}`}>
        <small className="se-label">ACTIVE INCIDENT</small>
        <span className="se-name" title={ev ? ev.name : undefined}>
          {ev ? ev.name : info.isLoading ? 'Loading…' : 'No active incident'}
        </span>
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

      <div className="side-bottom">
        {esc ? (
          <button className="assist" onClick={() => { select(esc.caseId); useUi.setState({ openCaseId: esc.caseId }); }}>
            <span className="ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={esc.kind === 'silent' ? '#C4B5FD' : '#FCA5A5'} strokeWidth="2" strokeLinecap="round"><path d="M12 3L2 21h20z" /><path d="M12 10v5M12 18v.5" /></svg></span>
            <div><small>LATEST ESCALATION</small><p>{esc.text}</p></div>
          </button>
        ) : (
          <div className="assist idle"><span className="ai"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#86EFAC" strokeWidth="2" strokeLinecap="round"><path d="M5 12l4 4 10-10" /></svg></span><div><small>LATEST ESCALATION</small><p>{open.isLoading ? 'Loading…' : 'Nothing escalated right now'}</p></div></div>
        )}

        <div className="side-profile">
          <div className="avatar" aria-hidden="true">{initials}</div>
          <div className="sp-info">
            <b title={me?.name}>{me?.name ?? 'Responder'}</b>
            <span className="muted">@{me?.username} · {me?.role}</span>
          </div>
          <button className="sp-logout" title="Sign out" aria-label="Sign out" onClick={() => void logout()}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}

function ConnectionStatusPopup() {
  const conn = useUi((s) => s.connection);
  const [everConnected, setEverConnected] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (conn === 'live') {
      setEverConnected(true);
      setDismissed(false);
    }
  }, [conn]);

  const isDisconnected = everConnected && (conn === 'offline' || conn === 'reconnecting');
  if (!isDisconnected || dismissed) return null;

  return (
    <div className="conn-modal-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="conn-title">
      <div className="conn-modal-card">
        <div className="conn-modal-head">
          <div className="conn-modal-icon">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#D32F2F" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="1" y1="1" x2="23" y2="23" />
              <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
              <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
              <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
              <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
              <line x1="12" y1="20" x2="12.01" y2="20" />
            </svg>
          </div>
          <div>
            <h2 id="conn-title">Server Connection Lost</h2>
            <span className="conn-badge">
              <span className="dot pulse-red" />
              {conn === 'reconnecting' ? 'Reconnecting to server…' : 'Server offline'}
            </span>
          </div>
        </div>
        <p className="conn-modal-desc">
          Lost live real-time connection to the Beacon command center. Incoming SOS alerts, triage scoring, and responder telemetry are currently paused.
        </p>
        <div className="conn-modal-actions">
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>
            Retry connection
          </button>
          <button type="button" className="btn" onClick={() => setDismissed(true)}>
            View cached data
          </button>
        </div>
      </div>
    </div>
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
        <div className="mobile-bar">
          <button className="icon-btn nav-toggle" aria-label="Open navigation" onClick={() => useUi.setState((s) => ({ navOpen: !s.navOpen }))}>
            <IcMenu width={20} height={20} />
          </button>
          <div className="logo">
            <LogoMark width={24} height={24} />
            <b>beacon</b>
          </div>
        </div>
        <Outlet />
      </main>
      <Toasts />
      <ConnectionStatusPopup />
      <CasePopover />
    </div>
  );
}
