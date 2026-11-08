import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../state/ui';
import { makeSos } from '../test/fixtures';
import { MapView } from './MapView';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  useUi.setState({ heatOpacity: 0.85, heatRadius: 'medium', layers: { sos: true, approx: true, responders: true, deadzones: true, heat: true, geofence: true } });
});

describe('MapView layers panel', () => {
  const ui = () => render(<MapView cases={[makeSos()]} selectedId={null} onSelect={() => {}} heat={{ cells: [], cellKm: 1 }} />);

  it('toggles the heat layer and controls', async () => {
    const user = userEvent.setup();
    ui();
    const cb = screen.getByRole('checkbox', { name: 'Heat' });
    expect(cb).toBeChecked();
    expect(screen.getByRole('slider', { name: 'Heat opacity' })).toBeEnabled();
    await user.click(cb);
    expect(useUi.getState().layers.heat).toBe(false);
    expect(screen.getByRole('slider', { name: 'Heat opacity' })).toBeDisabled();
  });

  it('changes opacity and the heat radius option', async () => {
    const user = userEvent.setup();
    ui();
    const slider = screen.getByRole('slider', { name: 'Heat opacity' });
    expect(slider).toHaveAttribute('aria-valuetext', '85 percent');
    fireEvent.change(slider, { target: { value: '60' } });
    expect(useUi.getState().heatOpacity).toBeCloseTo(0.6);
    expect(screen.getByRole('group', { name: 'Heat radius' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Large' }));
    expect(useUi.getState().heatRadius).toBe('large');
    expect(screen.getByRole('radio', { name: 'Large' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Medium' })).not.toBeChecked();
  });

  it('collapses and expands the layers menu', async () => {
    const user = userEvent.setup();
    ui();
    const btn = screen.getByRole('button', { name: /layers menu/i });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('checkbox', { name: 'Heat' })).toBeInTheDocument();

    await user.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('checkbox', { name: 'Heat' })).toBeNull();

    await user.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('checkbox', { name: 'Heat' })).toBeInTheDocument();
  });
});
