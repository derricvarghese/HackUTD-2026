import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/endpoints';
import type { AgentProposalDecision, AgentRun, Responder, Sos } from '../api/models';
import { makeSos } from '../test/fixtures';
import { AgentPanel } from './AgentPanel';

const mockResponders: Responder[] = [
  { id: 'resp-1', username: 'alice', name: 'Alice Smith', role: 'responder', available: true, in_app: true },
  { id: 'resp-2', username: 'bob', name: 'Bob Jones', role: 'responder', available: false, in_app: false },
];

const mockRun: AgentRun = {
  id: 'run-1',
  sos_id: 'case-1',
  status: 'complete',
  trigger: 'new_case',
  model: 'nemotron-3.5',
  created_at: '2026-11-08T12:00:00Z',
  steps: [
    {
      index: 0,
      turn: 0,
      type: 'plan',
      tool: null,
      summary: 'Checking flood hazards and nearest units',
      ok: null,
      ms: null,
      synthetic: false,
      cached: false,
      at: '2026-11-08T12:00:01Z',
    },
    {
      index: 1,
      turn: 0,
      type: 'tool_call',
      tool: 'get_weather_alerts',
      summary: 'Querying NWS weather alerts',
      ok: null,
      ms: null,
      synthetic: false,
      cached: false,
      at: '2026-11-08T12:00:02Z',
    },
    {
      index: 2,
      turn: 0,
      type: 'tool_result',
      tool: 'get_weather_alerts',
      summary: '1 active flash flood warning',
      ok: true,
      ms: 120,
      synthetic: true,
      cached: false,
      at: '2026-11-08T12:00:03Z',
    },
    {
      index: 3,
      turn: 1,
      type: 'final',
      tool: 'submit_assessment',
      summary: 'Assessment complete with dispatch recommendation',
      ok: true,
      ms: 50,
      synthetic: false,
      cached: false,
      at: '2026-11-08T12:00:04Z',
    },
  ],
  assessment: {
    summary: 'High water in residential area. Boat evacuation recommended.',
    urgency_delta: 10,
    confidence: 'high',
    evidence: [
      { source: 'get_weather_alerts', finding: 'Active Flash Flood Warning' },
      { source: 'get_river_gauges', finding: 'Stage: 18.5 ft, moderate flood' },
    ],
    risks: ['Rapidly rising waters', 'Elderly victim trapped'],
    recommendation: {
      responder_id: 'resp-1',
      eta_minutes: 15,
      equipment: ['boat', 'life jackets'],
      facility: { kind: 'hospital', name: 'Dallas General', distance_km: 3.5 },
      victim_message: 'Rescue boat dispatched, stay on roof.',
      notes: 'Roads impassable by standard vehicles.',
    },
    score_effect: {
      requested_delta: 10,
      applied_delta: 10,
      score_before: 70,
      score_after: 80,
    },
  },
  proposal: {
    id: 'prop-1',
    run_id: 'run-1',
    sos_id: 'case-1',
    kind: 'dispatch',
    responder_id: 'resp-1',
    responder_name: 'Alice Smith',
    eta_minutes: 15,
    equipment: ['boat', 'life jackets'],
    facility: { kind: 'hospital', name: 'Dallas General', distance_km: 3.5 },
    victim_message: 'Rescue boat dispatched, stay on roof.',
    notes: 'Impassable roads.',
    status: 'proposed',
    created_at: '2026-11-08T12:00:05Z',
  },
};

describe('AgentPanel', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, 'getCaseAgent').mockResolvedValue(mockRun);
    vi.spyOn(api, 'approveAgentProposal').mockResolvedValue({
      proposal: { ...mockRun.proposal!, status: 'approved' },
      assignment: { id: 'asg-1', sos_id: 'case-1', responder_id: 'resp-1', status: 'assigned', created_at: '2026-11-08T12:01:00Z' },
    } as unknown as AgentProposalDecision);
    vi.spyOn(api, 'rejectAgentProposal').mockResolvedValue({ ...mockRun.proposal!, status: 'rejected' });
  });

  const renderComponent = (caseData: Sos = makeSos({ id: 'case-1' }), isAdmin = true, canAct = true) => {
    return render(
      <QueryClientProvider client={qc}>
        <AgentPanel
          sosId="case-1"
          caseData={caseData}
          isAdmin={isAdmin}
          canAct={canAct}
          responders={mockResponders}
        />
      </QueryClientProvider>,
    );
  };

  it('renders agent assessment, evidence, risks, and turns', async () => {
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText(/High water in residential area/)).toBeInTheDocument();
    });

    expect(screen.getByText('Active Flash Flood Warning')).toBeInTheDocument();
    expect(screen.getByText('Rapidly rising waters')).toBeInTheDocument();
    expect(screen.getByText('Turn 0')).toBeInTheDocument();
    expect(screen.getByText('Turn 1')).toBeInTheDocument();
    expect(screen.getByText('synthetic')).toBeInTheDocument();
  });

  it('renders proposal card and allows approval', async () => {
    renderComponent();
    await waitFor(() => {
      expect(screen.getByTestId('proposal-card')).toBeInTheDocument();
    });

    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.getByText(/Dallas General/)).toBeInTheDocument();
    expect(screen.getByText('boat')).toBeInTheDocument();

    const approveBtn = screen.getByRole('button', { name: /Approve & Dispatch Unit/i });
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(api.approveAgentProposal).toHaveBeenCalledWith('case-1', 'prop-1', expect.objectContaining({
        eta_minutes: 15,
      }));
    });
  });

  it('allows rejecting a proposal with reason', async () => {
    renderComponent();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Reject…/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Reject…/i }));
    const input = screen.getByPlaceholderText(/e\.g\. Unit deployed elsewhere/i);
    fireEvent.change(input, { target: { value: 'Unit not ready' } });

    fireEvent.click(screen.getByRole('button', { name: /Confirm Rejection/i }));

    await waitFor(() => {
      expect(api.rejectAgentProposal).toHaveBeenCalledWith('case-1', 'prop-1', {
        reason: 'Unit not ready',
      });
    });
  });
});
