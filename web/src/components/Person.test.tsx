import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFull, makeProfile, makeSos } from '../test/fixtures';
import { useAuth } from '../state/auth';
import { CaseCard } from './CaseCard';
import { PersonSection } from './Person';

const wrap = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
);
const as = (role: 'admin' | 'responder' | 'volunteer') => useAuth.setState({ responder: { id: 'me', username: 'u', name: 'U', role } });
const NOW = Date.parse('2026-11-07T10:05:00Z');

describe('PersonSection', () => {
  it('locked for a responder: public view only, claim hint, no sensitive text', () => {
    as('responder');
    const { container } = render(wrap(<PersonSection c={makeSos({ profile: makeProfile() })} />));
    expect(screen.getByText('Maria Elena Gonzalez')).toBeInTheDocument();
    expect(screen.getByText('Claim this case to see medical and contact details')).toBeInTheDocument();
    expect(screen.queryByText('Private')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-full')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/penicillin|\+1972|Elm Street|insulin/);
  });
  it('locked for a volunteer uses the volunteer wording', () => {
    as('volunteer');
    render(wrap(<PersonSection c={makeSos({ profile: makeProfile() })} />));
    expect(screen.getByText('Only assigned responders and admins can see details')).toBeInTheDocument();
  });
  it('unlocked: shows details, private badge, reason, tel links and copy buttons', () => {
    as('responder');
    render(wrap(<PersonSection c={{ ...makeSos({ profile: makeProfile(), assignment: { id: 'a', sos_id: 's', responder_id: 'me', status: 'assigned' } as never }), profile_full: makeFull() }} />));
    expect(screen.getByText('Private')).toBeInTheDocument();
    expect(screen.getByText(/Visible to you because you are assigned/)).toBeInTheDocument();
    expect(screen.getByText('penicillin')).toBeInTheDocument();
    expect(screen.getByText('12 Elm Street, Plano TX', { exact: false })).toBeInTheDocument();
    const call = screen.getByRole('link', { name: /Call phone number/ });
    expect(call).toHaveAttribute('href', 'tel:+19725550142');
    expect(screen.getByRole('link', { name: /Call emergency contact phone/ })).toHaveAttribute('href', 'tel:+19725550177');
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeInTheDocument();
    expect(screen.queryByText(/Claim this case/)).not.toBeInTheDocument();
  });
  it('tolerates a sparse full profile', () => {
    as('admin');
    render(wrap(<PersonSection c={{ ...makeSos({ profile: makeProfile({ vulnerability_flags: [] }) }), profile_full: makeFull({ medical: undefined, mobility: undefined, household: undefined, phone: undefined, home_address: undefined, emergency_contact: undefined, notes: undefined }) }} />));
    expect(screen.getByTestId('profile-full')).toBeInTheDocument();
    expect(screen.queryByText('Medical')).not.toBeInTheDocument();
    expect(screen.getByText(/because you are an admin/)).toBeInTheDocument();
  });
  it('no profile: Unknown person and not-synced hint, nothing to unlock', () => {
    as('responder');
    render(wrap(<PersonSection c={makeSos({ profile: null })} />));
    expect(screen.getByText('Unknown person')).toBeInTheDocument();
    expect(screen.getByText('profile not synced')).toBeInTheDocument();
    expect(screen.queryByText(/Claim this case to see/)).not.toBeInTheDocument();
  });
  it('mesh summary: name with the explanatory hint', () => {
    as('responder');
    render(wrap(<PersonSection c={makeSos({ profile: makeProfile({ has_profile: false, source: 'mesh_summary', preferred_name: undefined }) })} />));
    expect(screen.getByText('Name from SOS message; full profile not synced yet')).toBeInTheDocument();
    expect(screen.getByText('Maria Elena Gonzalez')).toBeInTheDocument();
  });
});

describe('CaseCard person rendering', () => {
  beforeEach(() => as('responder'));
  it('shows the name, age chip and flag chips with accessible labels', () => {
    render(wrap(<CaseCard c={makeSos({ profile: makeProfile() })} selected={false} onSelect={() => undefined} now={NOW} />));
    const line = screen.getByTestId('person-line');
    expect(within(line).getByText('Maria Elena Gonzalez')).toBeInTheDocument();
    expect(within(line).getByText('\u201cElena\u201d', { exact: false })).toBeInTheDocument();
    expect(within(line).getByText('Age 65-79')).toBeInTheDocument();
    expect(within(line).getByText('Oxygen dependent')).toBeInTheDocument();
    expect(screen.getByText(/SOS-1A2B · Trapped/)).toBeInTheDocument();
  });
  it('collapses many flags to a +N chip and handles very long names', () => {
    const long = 'Alexandria Bartholomew Montgomery-Featherstonehaugh de la Cruz y Hernandez-Villanueva';
    render(wrap(<CaseCard c={makeSos({ profile: makeProfile({ full_name: long, vulnerability_flags: ['oxygen', 'mobility', 'medical', 'sensory', 'cognitive', 'elderly', 'child'] }) })} selected={false} onSelect={() => undefined} now={NOW} />));
    expect(screen.getByText(long)).toHaveAttribute('title', expect.stringContaining('Alexandria'));
    expect(screen.getByText(/and 3 more/)).toBeInTheDocument();
  });
  it('falls back to Unknown person with a hint when there is no profile', () => {
    render(wrap(<CaseCard c={makeSos({ profile: null })} selected={false} onSelect={() => undefined} now={NOW} />));
    expect(screen.getByText('Unknown person')).toBeInTheDocument();
    expect(screen.getByText('profile not synced')).toBeInTheDocument();
  });
});
