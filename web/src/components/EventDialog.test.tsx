import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as api from '../api/endpoints';
import type { AppEvent } from '../api/models';
import { shapeToRegion } from '../lib/geofenceShape';
import { EventDialog } from './EventDialog';
import { GeofenceMini } from './GeofenceMini';

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

const wrap = (ui: React.ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

describe('EventDialog', () => {
  it('keeps Create disabled until there is a name and a valid geofence, then sends polygon + bbox', async () => {
    const create = vi.spyOn(api, 'createEvent').mockResolvedValue({ id: 'x' } as AppEvent);
    const onClose = vi.fn();
    const u = userEvent.setup();
    render(wrap(<EventDialog onClose={onClose} />));
    const save = screen.getByRole('button', { name: 'Create event' });
    expect(save).toBeDisabled();
    expect(screen.getByText('Draw the geofence on the map.')).toBeInTheDocument();
    await u.type(screen.getByLabelText('Name'), 'Flood');
    await u.click(screen.getByText('Type the numbers instead'));
    await u.type(screen.getByLabelText('South latitude'), '32.7');
    await u.type(screen.getByLabelText('West longitude'), '-96.9');
    await u.type(screen.getByLabelText('North latitude'), '32.9');
    await u.type(screen.getByLabelText('East longitude'), '-96.6');
    await u.click(screen.getByRole('button', { name: 'Apply rectangle' }));
    await waitFor(() => expect(save).toBeEnabled());
    await u.click(save);
    await waitFor(() => expect(create).toHaveBeenCalled());
    const body = create.mock.calls[0][0] as { name: string; region: { min_lat: number; max_lng: number; geofence: { type: string; coordinates: number[][][] } } };
    expect(body.name).toBe('Flood');
    expect(body.region).toMatchObject({ min_lat: 32.7, max_lng: -96.6 });
    expect(body.region.geofence.type).toBe('Polygon');
    expect(body.region.geofence.coordinates[0]).toHaveLength(5);
  });

  it('rejects impossible numbers and a silence threshold shorter than two heartbeats', async () => {
    const u = userEvent.setup();
    render(wrap(<EventDialog onClose={() => undefined} />));
    await u.click(screen.getByText('Type the numbers instead'));
    await u.type(screen.getByLabelText('South latitude'), '40');
    await u.type(screen.getByLabelText('West longitude'), '-96');
    await u.type(screen.getByLabelText('North latitude'), '30');
    await u.type(screen.getByLabelText('East longitude'), '-95');
    await u.click(screen.getByRole('button', { name: 'Apply rectangle' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/South must be below north/);
    await u.clear(screen.getByLabelText('Silence threshold (seconds)'));
    await u.type(screen.getByLabelText('Silence threshold (seconds)'), '100');
    expect(screen.getByText(/at least twice the heartbeat interval/)).toBeInTheDocument();
  });

  it('shows a closed event read-only: no tools, no save', () => {
    const ev = { id: 'e', name: 'Old', status: 'closed', region: shapeToRegion({ kind: 'circle', lat: 32.78, lng: -96.8, radius_m: 2000 }), created_at: '2026-11-01T00:00:00Z' } as AppEvent;
    render(wrap(<EventDialog event={ev} onClose={() => undefined} />));
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save changes/ })).toBeNull();
    expect(screen.getByText(/can no longer be changed/)).toBeInTheDocument();
    expect(screen.getByText('64 (circle)')).toBeInTheDocument();
  });
});

describe('GeofenceMini', () => {
  it('draws the outline, or says there is no area', () => {
    const { container, rerender } = render(<GeofenceMini region={shapeToRegion({ kind: 'rectangle', bounds: { min_lat: 1, min_lng: 1, max_lat: 2, max_lng: 2 } })} />);
    expect(container.querySelector('polygon')).not.toBeNull();
    rerender(<GeofenceMini region={null} />);
    expect(screen.getByText('No area')).toBeInTheDocument();
  });
});
