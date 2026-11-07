import { describe, expect, it } from 'vitest';
import { matchOffer, needsOf, NEEDS_FOR_KIND, type MatchOffer, type MatchSos } from '../../src/domain/matching';

const offer: MatchOffer = { kind: 'boat', status: 'open', lat: 32.99, lng: -96.75, radius_km: 3, capacity: 4, expires_at: null };
const sos: MatchSos = { category: 'trapped', status: 'reported', lat: 32.995, lng: -96.75, score: 90, people_count: 2 };

describe('offer matching', () => {
  it('maps kinds to needs per the design (boat<-trapped, water<-need_water_meds, medical<-injured)', () => {
    expect(NEEDS_FOR_KIND.boat).toEqual(['trapped']);
    expect(NEEDS_FOR_KIND.water).toEqual(['need_water_meds']);
    expect(NEEDS_FOR_KIND.medical).toEqual(['injured']);
  });
  it('matches a nearby need and scores it 0..1 with a rounded distance', () => {
    const m = matchOffer(offer, sos)!;
    expect(m.distance_km).toBeGreaterThan(0.4);
    expect(m.distance_km).toBeLessThan(0.7);
    expect(m.score).toBeGreaterThan(0.5);
    expect(m.score).toBeLessThanOrEqual(1);
  });
  it('closer and more urgent cases score higher', () => {
    const near = matchOffer(offer, sos)!.score;
    expect(matchOffer(offer, { ...sos, lat: 33.01 })!.score).toBeLessThan(near);
    expect(matchOffer(offer, { ...sos, score: 40 })!.score).toBeLessThan(near);
  });
  it.each([
    ['wrong kind of need', { ...sos, category: 'need_water_meds' }],
    ['outside the radius', { ...sos, lat: 33.1 }],
    ['resolved case', { ...sos, status: 'resolved' }],
    ['merged case', { ...sos, status: 'merged' }],
    ['safe case', { ...sos, category: 'safe' }],
    ['no location', { ...sos, lat: null, lng: null }],
  ])('no match: %s', (_n, s) => expect(matchOffer(offer, s as MatchSos)).toBeNull());
  it('respects offer status, expiry and capacity', () => {
    expect(matchOffer({ ...offer, status: 'withdrawn' }, sos)).toBeNull();
    expect(matchOffer({ ...offer, status: 'completed' }, sos)).toBeNull();
    expect(matchOffer({ ...offer, status: 'matched' }, sos)).not.toBeNull();
    expect(matchOffer({ ...offer, expires_at: new Date(Date.now() - 1000) }, sos)).toBeNull();
    expect(matchOffer({ ...offer, capacity: 0 }, sos)).toBeNull();
  });
  it('flags can express a need the category does not', () => {
    expect(needsOf({ ...sos, category: 'other', injured: true })).toEqual(['other', 'injured']);
    expect(matchOffer({ ...offer, kind: 'medical' }, { ...sos, category: 'other', injured: true })).not.toBeNull();
  });
});
