import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuth } from '../state/auth';
import { useUi } from '../state/ui';
import { Shell } from './Shell';

function renderShell(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Shell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Shell', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useAuth.setState({
      responder: { id: 'r1', username: 'jsmith', name: 'John Smith', role: 'admin' },
    });
    useUi.setState({ connection: 'connecting' });
  });

  it('renders active disaster in the sidebar under logo and profile at the bottom', () => {
    queryClient.setQueryData(['server-info'], {
      event: { id: 'ev1', name: 'Hurricane Alex', status: 'active' },
    });
    queryClient.setQueryData(['cases', 'open'], [
      { id: 'c1', category: 'trapped', score: 85, status: 'reported' },
      { id: 'c2', category: 'safe', score: 10, status: 'reported' }, // safe excluded
    ]);

    renderShell(queryClient);

    // Active incident in sidebar
    expect(screen.getByText('ACTIVE INCIDENT')).toBeInTheDocument();
    expect(screen.getByText('Hurricane Alex')).toBeInTheDocument();
    expect(screen.queryByText(/offline mesh · ai triage/i)).toBeNull();

    // Profile in sidebar
    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText('@jsmith · admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();

    // Queue count in sidebar navigation shows 1 (only urgent case, safe excluded)
    const queueLink = screen.getByRole('link', { name: /triage queue/i });
    expect(queueLink).toHaveTextContent('1');
  });

  it('shows connection lost modal when connection is lost after being live', async () => {
    const user = userEvent.setup();
    useUi.setState({ connection: 'live' });
    renderShell(queryClient);

    // Initially live: no lost modal
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // Connection drops to offline
    act(() => {
      useUi.setState({ connection: 'offline' });
    });

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Server Connection Lost' })).toBeInTheDocument();
    expect(screen.getByText(/Lost live real-time connection to the Beacon command center/i)).toBeInTheDocument();

    // Dismiss with "View cached data"
    await user.click(screen.getByRole('button', { name: 'View cached data' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('opens a case in a popover sheet without navigating away', async () => {
    const user = userEvent.setup();
    queryClient.setQueryData(['sos', 'c1'], {
      id: 'c1',
      category: 'trapped',
      score: 85,
      status: 'reported',
      approx_location: { lat: 32.78, lng: -96.8, radius_m: 1000 },
      created_at: new Date().toISOString(),
      last_heard_at: new Date().toISOString(),
      channel: 'app',
    });

    renderShell(queryClient);

    expect(screen.queryByRole('dialog', { name: 'Case details' })).toBeNull();

    act(() => {
      useUi.setState({ openCaseId: 'c1' });
    });

    expect(screen.getByRole('dialog', { name: 'Case details' })).toBeInTheDocument();
    expect(screen.getByText('Trapped')).toBeInTheDocument();

    // Close button dismisses the popover
    await user.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('dialog', { name: 'Case details' })).toBeNull();
  });
});
