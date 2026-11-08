import { buildQueryString } from '../api/client';
import { makeSos } from '../test/fixtures';
import { bboxParam, buildSosQuery, matchesSearch, matchesTab } from './query';

describe('query building', () => {
  it('serialises arrays comma separated and drops empties', () => {
    expect(buildQueryString({ status: ['reported', 'assigned'], q: '', limit: 50, silent: true, x: undefined, none: [] })).toBe('?status=reported%2Cassigned&limit=50&silent=true');
    expect(buildQueryString({})).toBe('');
    expect(buildQueryString(undefined)).toBe('');
  });
  it('maps tabs to server filters', () => {
    expect(buildSosQuery({ tab: 'all' })).toMatchObject({ sort: 'priority', status: ['reported', 'assigned', 'en_route', 'on_scene'] });
    expect(buildSosQuery({ tab: 'critical' }).min_score).toBe(80);
    expect(buildSosQuery({ tab: 'high' }).min_score).toBe(50);
    expect(buildSosQuery({ tab: 'silent' }).silent).toBe(true);
    expect(buildSosQuery({ tab: 'assigned' }).status).toEqual(['assigned', 'en_route', 'on_scene']);
    expect(buildSosQuery({ tab: 'all', search: '  boat ' }).q).toBe('boat');
    expect(buildSosQuery({ tab: 'all', includeResolved: true }).status).toContain('resolved');
    expect(buildSosQuery({ tab: 'all', assignedTo: 'none' }).assigned_to).toBe('none');
  });
  it('finishes the high band client side', () => {
    expect(matchesTab(makeSos({ score: 60 }), 'high')).toBe(true);
    expect(matchesTab(makeSos({ score: 85 }), 'high')).toBe(false);
    expect(matchesTab(makeSos({ score: 85 }), 'critical')).toBe(true);
    expect(matchesTab(makeSos({ silent: true }), 'silent')).toBe(true);
    expect(matchesTab(makeSos(), 'assigned')).toBe(false);
    expect(matchesTab(makeSos({ assignment: { id: 'a', responder_id: 'r', status: 'en_route' } }), 'assigned')).toBe(true);
  });
  it('excludes safe category and low scores (<20) from all queue tabs', () => {
    expect(matchesTab(makeSos({ category: 'safe', score: 5 }), 'all')).toBe(false);
    expect(matchesTab(makeSos({ category: 'safe', score: 90 }), 'all')).toBe(false);
    expect(matchesTab(makeSos({ category: 'trapped', score: 10 }), 'all')).toBe(false);
    expect(matchesTab(makeSos({ category: 'safe' }), 'silent')).toBe(false);
  });
  it('searches visible text', () => {
    expect(matchesSearch(makeSos(), 'WATER', 'x')).toBe(true);
    expect(matchesSearch(makeSos(), 'zzz', 'x')).toBe(false);
    expect(matchesSearch(makeSos(), '  ', 'x')).toBe(true);
  });
  it('orders bbox as min_lng,min_lat,max_lng,max_lat', () => {
    expect(bboxParam({ min_lat: 1, min_lng: 2, max_lat: 3, max_lng: 4 })).toBe('2,1,4,3');
  });
});
