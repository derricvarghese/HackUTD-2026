import { describe, expect, it } from 'vitest';
import { canSeeExact, toSosView, type SosViewInput, type Viewer } from '../../src/domain/privacy';
import type { SosRow } from '../../src/db/types';

const row = {
  id: '0192a7d4-1c2e-7000-8a00-0000000000a1', event_id: null, device_id: 'd', sender_hash: 'abc', channel: 'mesh', category: 'trapped', status: 'assigned',
  lat: 32.9857, lng: -96.7501, geohash7: 'x', approx_lat: 32.985, approx_lng: -96.75, text: 'help', people_count: 2, trapped: true, water_rising: true, injured: false,
  accuracy_m: null, score: 90, score_override: null, confidence: 'high', silent: false, silent_since: null, merged_into: null, duplicate_count: 0, version: 1,
  last_heard_at: new Date(), hop_count: 3, max_hops: 10, hop_path: ['A1'], gateway_device_id: null, original_created_at: new Date(), received_at: new Date(),
  has_voice_note: false, synthetic: true, created_at: new Date(), updated_at: new Date(),
} as SosRow;
const claim = (status: string): SosViewInput['assignment'] => ({ id: 'a1', responder_id: 'r-alice', responder_name: 'Alice', status: status as never, eta_minutes: 30 });
const input = (assignment: SosViewInput['assignment']): SosViewInput => ({ row, reasons: [], assignment });
const resp = (id: string, role: 'responder' | 'volunteer' | 'admin' = 'responder'): Viewer => ({ kind: 'responder', id, role });

describe('privacy: exact location', () => {
  it('is hidden from everyone with no assignment, except admin', () => {
    expect(toSosView(input(null), resp('r-alice')).location).toBeNull();
    expect(toSosView(input(null), { kind: 'device', id: 'd' }).location).toBeNull();
    expect(toSosView(input(null), { kind: 'anon' }).location).toBeNull();
    expect(toSosView(input(null), resp('x', 'admin')).location).toEqual({ lat: 32.9857, lng: -96.7501 });
  });
  it.each(['assigned', 'en_route', 'on_scene'])('active assignee sees it (%s), others do not', (st) => {
    expect(toSosView(input(claim(st)), resp('r-alice')).location).toEqual({ lat: 32.9857, lng: -96.7501 });
    expect(toSosView(input(claim(st)), resp('r-bob')).location).toBeNull();
    expect(toSosView(input(claim(st)), resp('r-carol', 'volunteer')).location).toBeNull();
  });
  it.each(['resolved', 'released', 'cancelled'])('a %s assignment no longer grants exact location', (st) => {
    expect(toSosView(input(claim(st)), resp('r-alice')).location).toBeNull();
  });
  it('always exposes only approx coordinates and never the raw exact point elsewhere', () => {
    const json = JSON.stringify(toSosView(input(claim('assigned')), resp('r-bob')));
    expect(json).not.toContain('32.9857');
    expect(json).not.toContain('-96.7501');
    expect(json).toContain('32.985');
  });
  it('canSeeExact helper', () => {
    expect(canSeeExact(resp('a'), 'a')).toBe(true);
    expect(canSeeExact(resp('a'), null)).toBe(false);
    expect(canSeeExact({ kind: 'device', id: 'a' }, 'a')).toBe(false);
  });
  it('score_override wins in the view', () => {
    expect(toSosView({ ...input(null), row: { ...row, score_override: 12 } }, resp('a')).score).toBe(12);
  });
});
