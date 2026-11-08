import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeSos } from '../test/fixtures';
import { useAuth } from '../state/auth';
import { useUi } from '../state/ui';
import { CaseCard } from './CaseCard';
import { AiChip, CameraChip, ContactChip } from './chips';
import { buildCasePopup } from './MapView';
import { ScoreSq } from './ui';

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
);
const NOW = Date.parse('2026-11-07T10:30:00Z');

beforeEach(() => {
  useAuth.setState({ responder: { id: 'me', username: 'alice', name: 'Alice', role: 'responder' } });
  useUi.setState({ triageChanges: {} });
});

describe('AI pending badge', () => {
  it('marks provisional scores with the pending ring and the rules tooltip', () => {
    render(<ScoreSq c={{ id: 'x', score: 65, triage_status: 'provisional' }} />);
    const sq = screen.getByTitle(/Provisional score from rules; AI is still analysing/);
    expect(sq).toHaveClass('ai-pending');
    expect(sq).toHaveTextContent('65');
  });
  it('failed scores say rules only and are not styled as pending', () => {
    render(<ScoreSq c={{ id: 'x', score: 65, triage_status: 'failed' }} />);
    const sq = screen.getByTitle(/AI unavailable, rules only/);
    expect(sq).toHaveClass('ai-failed');
    expect(sq).not.toHaveClass('ai-pending');
  });
  it('complete scores look normal, and flash after the AI changed them', () => {
    const { rerender } = render(<ScoreSq c={{ id: 'x', score: 75, triage_status: 'complete' }} />);
    const sq = screen.getByText('75');
    expect(sq.className).toBe('sq');
    useUi.setState({ triageChanges: { x: { from: 65, to: 75, delta: 10, at: 1 } } });
    rerender(<ScoreSq c={{ id: 'x', score: 75, triage_status: 'complete' }} />);
    expect(screen.getByText('75')).toHaveClass('ai-flash');
  });
  it('the queue card badge carries the marker and its accessible name says AI pending', () => {
    render(wrap(<CaseCard c={makeSos({ triage_status: 'provisional' })} selected={false} onSelect={() => undefined} now={NOW} />));
    expect(screen.getByTestId('case-card').querySelector('.badge')).toHaveClass('ai-pending');
    expect(screen.getByTestId('case-card')).toHaveAccessibleName(/AI pending/);
  });
  it('AiChip renders nothing once complete', () => {
    const { container, rerender } = render(<AiChip status="complete" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AiChip status="provisional" />);
    expect(screen.getByTestId('ai-chip')).toHaveTextContent(/AI pending/);
  });
  it('the map popup explains a provisional score', () => {
    const pop = buildCasePopup(makeSos({ triage_status: 'provisional' }), () => undefined);
    expect(pop.textContent).toContain('Provisional score from rules; AI is still analysing');
  });
});

describe('connectivity chips', () => {
  it('renders the three contact states with their wording', () => {
    const base = makeSos({ last_heartbeat_at: '2026-11-07T10:18:00Z' });
    const { rerender } = render(<ContactChip c={{ ...base, contact_state: 'connected' }} now={NOW} />);
    expect(screen.getByTestId('contact-chip')).toHaveClass('green');
    rerender(<ContactChip c={{ ...base, contact_state: 'lost_contact' }} now={NOW} />);
    expect(screen.getByTestId('contact-chip')).toHaveClass('amber');
    expect(screen.getByTestId('contact-chip')).toHaveAttribute('title', 'Lost contact: probably no connectivity (last heartbeat 12 min ago)');
    rerender(<ContactChip c={{ ...base, contact_state: 'unresponsive', welfare_missed: 1 }} now={NOW} />);
    expect(screen.getByTestId('contact-chip')).toHaveClass('red');
    expect(screen.getByTestId('contact-chip')).toHaveTextContent('Unresponsive: connected but not answering welfare check-ins');
  });
  it('renders nothing when the server sends no contact state', () => {
    const { container } = render(<ContactChip c={makeSos()} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('cards show Last heard from last_heard_at, a camera count and the chip', () => {
    render(wrap(<CaseCard c={makeSos({ contact_state: 'unresponsive', image_count: 3, last_heard_at: '2026-11-07T10:25:00Z' })} selected={false} onSelect={() => undefined} now={NOW} />));
    expect(screen.getByText('Last heard 5 min ago')).toBeInTheDocument();
    expect(screen.getByTestId('contact-chip')).toHaveAttribute('data-state', 'unresponsive');
    expect(screen.getByTestId('camera-chip')).toHaveTextContent('3 photos');
  });
  it('camera chip is hidden at zero', () => {
    const { container } = render(<CameraChip count={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
