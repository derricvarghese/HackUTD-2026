import { makeFull, makeProfile, makeSos } from '../test/fixtures';
import {
  HINT_MESH_SUMMARY, HINT_UNSYNCED, LOCKED_TEXT, UNKNOWN_PERSON, ageLabel, displayName, flagsSummary, hasAny, nameLine, personAccess, petsLabel, sortFlags, telHref, unlockedReason,
} from './profile';
import { matchesSearch } from './query';

describe('age and flag labels', () => {
  it('maps age ranges to labels', () => {
    expect(ageLabel('65-79')).toBe('Age 65-79');
    expect(ageLabel('0-12')).toBe('Child (0-12)');
    expect(ageLabel(undefined)).toBeNull();
  });
  it('orders flags by urgency, drops duplicates and describes them', () => {
    expect(sortFlags(['cognitive', 'elderly', 'oxygen', 'oxygen', 'medical'])).toEqual(['oxygen', 'medical', 'elderly', 'cognitive']);
    expect(flagsSummary(['child', 'oxygen'])).toBe('Oxygen dependent, Child (12 or younger)');
    expect(sortFlags(undefined)).toEqual([]);
  });
});

describe('displayName', () => {
  it('uses the full name and a distinct preferred name', () => {
    const d = displayName(makeProfile());
    expect(d).toMatchObject({ primary: 'Maria Elena Gonzalez', preferred: 'Elena', known: true });
    expect(d.hint).toBeUndefined();
    expect(nameLine(makeProfile())).toBe('Maria Elena Gonzalez “Elena”');
  });
  it('hides a preferred name equal to the full name', () => {
    expect(displayName(makeProfile({ full_name: 'Sam Lee', preferred_name: 'sam lee' })).preferred).toBeUndefined();
  });
  it('falls back to Unknown person when there is no profile or name', () => {
    expect(displayName(null)).toEqual({ primary: UNKNOWN_PERSON, known: false, hint: HINT_UNSYNCED });
    expect(displayName(makeProfile({ full_name: '  ' })).primary).toBe(UNKNOWN_PERSON);
  });
  it('explains mesh-summary names', () => {
    const d = displayName(makeProfile({ has_profile: false, source: 'mesh_summary' }));
    expect(d.known).toBe(true);
    expect(d.hint).toBe(HINT_MESH_SUMMARY);
  });
});

describe('personAccess (privacy gating)', () => {
  it('unlocks only when profile_full is present', () => {
    expect(personAccess({ profile: makeProfile(), profile_full: makeFull() }, true, 'me')).toBe('unlocked');
    expect(personAccess({ profile: makeProfile() }, true, 'me')).toBe('locked_claim');
  });
  it('never unlocks from flags, role or assignment alone', () => {
    const c = { profile: makeProfile({ vulnerability_flags: ['oxygen', 'medical'] }), assignment: { id: 'a', sos_id: 's', responder_id: 'me', status: 'assigned' } } as never;
    expect(personAccess(c, true, 'me')).toBe('locked_claim');
  });
  it('volunteers always get the volunteer wording', () => {
    expect(personAccess({ profile: makeProfile() }, false)).toBe('locked_volunteer');
    expect(LOCKED_TEXT.locked_volunteer).toBe('Only assigned responders and admins can see details');
    expect(LOCKED_TEXT.locked_claim).toBe('Claim this case to see medical and contact details');
  });
  it('says someone else holds the case', () => {
    const a = { id: 'a', sos_id: 's', responder_id: 'other', status: 'en_route' } as never;
    expect(personAccess({ profile: makeProfile(), assignment: a }, true, 'me')).toBe('locked_other');
    const released = { id: 'a', sos_id: 's', responder_id: 'other', status: 'released' } as never;
    expect(personAccess({ profile: makeProfile(), assignment: released }, true, 'me')).toBe('locked_claim');
  });
  it('has nothing to unlock without a synced profile', () => {
    expect(personAccess({ profile: null }, true)).toBe('unsynced');
    expect(personAccess({ profile: makeProfile({ has_profile: false, source: 'mesh_summary' }) }, true)).toBe('unsynced');
  });
  it('words the unlock reason', () => {
    expect(unlockedReason(false, true)).toMatch(/assigned/);
    expect(unlockedReason(true, false)).toMatch(/admin/);
  });
});

describe('formatting helpers', () => {
  it('builds dialable tel links', () => {
    expect(telHref('+1 (972) 555-0142')).toBe('tel:+19725550142');
    expect(telHref('972.555.0142')).toBe('tel:9725550142');
    expect(telHref('n/a')).toBeNull();
    expect(telHref(undefined)).toBeNull();
  });
  it('formats pets and detects empty groups', () => {
    expect(petsLabel([{ kind: 'dog', count: 2 }, { kind: 'cat' }])).toBe('2 dogs, cat');
    expect(petsLabel([])).toBeNull();
    expect(hasAny({ conditions: [] })).toBe(false);
    expect(hasAny({ conditions: ['x'] })).toBe(true);
    expect(hasAny(undefined)).toBe(false);
  });
});

describe('search matches names', () => {
  const c = makeSos({ profile: makeProfile() });
  it('matches full and preferred name, case-insensitively', () => {
    expect(matchesSearch(c, 'gonzalez', 'SOS-1A2B Trapped')).toBe(true);
    expect(matchesSearch(c, 'ELENA', 'SOS-1A2B Trapped')).toBe(true);
    expect(matchesSearch(c, 'nobody', 'SOS-1A2B Trapped')).toBe(false);
  });
  it('still matches cases without a profile by other fields', () => {
    expect(matchesSearch(makeSos(), 'upstairs', 'x')).toBe(true);
    expect(matchesSearch(makeSos({ profile: null }), 'gonzalez', 'x')).toBe(false);
  });
});
