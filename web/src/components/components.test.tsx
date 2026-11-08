import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { makeSilent, makeSos } from '../test/fixtures';
import { useAuth } from '../state/auth';
import { Login } from '../views/Login';
import { CaseCard, DeviceCard } from './CaseCard';
import { buildCasePopup } from './MapView';
import { ConfirmDialog, StatusTrail } from './ui';

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
);

const NOW = Date.parse('2026-11-07T10:05:00Z');

describe('CaseCard', () => {
  beforeEach(() => useAuth.setState({ responder: { id: 'me', username: 'alice', name: 'Alice', role: 'responder' } }));

  it('renders score, tier, reasons, channel and a claim button', async () => {
    const onSelect = vi.fn();
    render(wrap(<CaseCard c={makeSos()} selected={false} onSelect={onSelect} now={NOW} />));
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
    expect(screen.getByText('90')).toBeInTheDocument();
    expect(screen.getByText('Mesh · 3 hops')).toBeInTheDocument();
    expect(screen.getByText(/Trapped with rising water/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Claim SOS-1A2B/ })).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/SOS-1A2B, Trapped, score 90/));
    expect(onSelect).toHaveBeenCalled();
  });

  it('flags silent cases and shows the exact precision honestly', () => {
    render(wrap(<CaseCard c={makeSos({ silent: true, silent_since: '2026-11-07T10:00:00Z' })} selected onSelect={() => undefined} now={NOW} />));
    expect(screen.getByText('SILENT')).toBeInTheDocument();
    expect(screen.getByText('Silent 5 min')).toBeInTheDocument();
    expect(screen.getByText(/~1 km area/)).toBeInTheDocument();
  });

  it('hides claim for volunteers and shows the assignee when claimed', () => {
    useAuth.setState({ responder: { id: 'v', username: 'carol', name: 'Carol', role: 'volunteer' } });
    const { rerender } = render(wrap(<CaseCard c={makeSos()} selected={false} onSelect={() => undefined} now={NOW} />));
    expect(screen.queryByRole('button', { name: /Claim/ })).toBeNull();
    rerender(wrap(<CaseCard c={makeSos({ status: 'en_route', assignment: { id: 'a', responder_id: 'r', responder_name: 'Team Delta', status: 'en_route', eta_minutes: 40 } })} selected={false} onSelect={() => undefined} now={NOW} />));
    expect(screen.getByText('Team Delta')).toBeInTheDocument();
    expect(screen.getByLabelText('Status: En route')).toHaveTextContent('ETA 40 min');
  });
});

describe('DeviceCard', () => {
  it('shows a promote action for a silent device', async () => {
    const onPromote = vi.fn();
    render(wrap(<DeviceCard d={makeSilent()} now={NOW} onPromote={onPromote} busy={false} canAct />));
    expect(screen.getByText('POSSIBLE DISTRESS')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Promote device DEV-7F2C/ }));
    expect(onPromote).toHaveBeenCalled();
  });
});

describe('ui bits', () => {
  it('marks the current step in the status trail', () => {
    render(<StatusTrail status="on_scene" />);
    expect(screen.getByLabelText('Status: On scene')).toHaveTextContent('Reported');
  });
  it('confirms destructive actions and closes on Escape', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmDialog title="Purge?" body="Gone forever" confirmLabel="Purge data" danger onClose={onClose} onConfirm={onConfirm} />);
    expect(screen.getByRole('dialog', { name: 'Purge?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Purge data' }));
    expect(onConfirm).toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('map popup', () => {
  it('shows score, hop chain and the approximate precision; escapes text', () => {
    const el = buildCasePopup(makeSos({ text: '<b>hi</b>' }), () => undefined);
    expect(el.textContent).toContain('SOS-1A2B · Trapped');
    expect(el.textContent).toContain('Arrived via 3 hops');
    expect(el.textContent).toContain('approximate area, within 1 km');
    expect(el.querySelectorAll('.hop').length).toBe(4);
    expect(el.querySelector('b')).toBeNull();
    const exact = buildCasePopup(makeSos({ location: { lat: 1, lng: 2 } }), () => undefined);
    expect(exact.textContent).toContain('exact location');
  });
});

describe('Login', () => {
  it('submits credentials and shows a friendly error', async () => {
    const login = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 401 }));
    useAuth.setState({ login, error: null });
    render(<Login />);
    await userEvent.type(screen.getByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(login).toHaveBeenCalledWith('admin', 'nope');
    // non-ApiError falls back to a generic message
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign in.');
  });
});
