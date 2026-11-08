import type { ProfileFull, ProfilePublic, Sos, SilentDevice } from '../api/models';

export function makeSos(over: Partial<Sos> = {}): Sos {
  return {
    id: '0198aaaa-bbbb-7ccc-8ddd-eeeeeeee1a2b',
    sender_hash: 'abc',
    channel: 'mesh',
    category: 'trapped',
    status: 'reported',
    approx_location: { lat: 32.78, lng: -96.8, radius_m: 1000 },
    text: 'Trapped upstairs, water rising',
    people_count: 2,
    score: 90,
    confidence: 'high',
    reasons: [
      { source: 'rule', text: 'Trapped with rising water is always critical.', weight: 90 },
      { source: 'llm', text: 'Mentions oxygen tank', weight: 6 },
    ],
    last_heard_at: '2026-11-07T10:00:00Z',
    hop: { hop_count: 3, max_hops: 10, hop_path: ['A1', 'B7', 'C3'] },
    created_at: '2026-11-07T10:00:00Z',
    received_at: '2026-11-07T10:00:40Z',
    ...over,
  } as Sos;
}

export function makeSilent(over: Partial<SilentDevice> = {}): SilentDevice {
  return {
    device_id: '11111111-2222-3333-4444-555555557f2c',
    sender_hash: 'h',
    status: 'distress',
    last_heartbeat_at: '2026-11-07T10:00:00Z',
    silent_for_seconds: 1320,
    last_approx: { lat: 32.7, lng: -96.7, radius_m: 1000 },
    priority_score: 71,
    ...over,
  } as SilentDevice;
}

export function makeProfile(over: Partial<ProfilePublic> = {}): ProfilePublic {
  return {
    view: 'public',
    full_name: 'Maria Elena Gonzalez',
    preferred_name: 'Elena',
    age_range: '65-79',
    vulnerability_flags: ['elderly', 'medical', 'mobility', 'oxygen'],
    has_profile: true,
    source: 'synced',
    profile_version: 3,
    ...over,
  };
}

export function makeFull(over: Partial<ProfileFull> = {}): ProfileFull {
  return {
    view: 'full',
    device_id: '0192a000-0000-7000-8000-0000000000d1',
    profile_version: 3,
    full_name: 'Maria Elena Gonzalez',
    preferred_name: 'Elena',
    birth_year: 1951,
    age_range: '65-79',
    vulnerability_flags: ['elderly', 'medical', 'mobility', 'oxygen'],
    languages: ['es', 'en'],
    phone: '+19725550142',
    medical: { conditions: ['type 2 diabetes'], medications: ['insulin glargine'], allergies: ['penicillin'], blood_type: 'O+' },
    mobility: { needs: ['walks_with_aid', 'oxygen_dependent'], notes: 'portable oxygen concentrator' },
    household: { people_count: 2, pets: [{ kind: 'dog', count: 1 }] },
    home_address: '12 Elm Street, Plano TX',
    emergency_contact: { name: 'Daniel Gonzalez', phone: '+19725550177', relationship: 'son' },
    notes: 'Gate code 4411',
    consent: { accepted: true, version: '2026-11-v1', accepted_at: '2026-11-07T15:58:00Z' },
    created_at: '2026-11-07T15:58:00Z',
    updated_at: '2026-11-07T16:30:00Z',
    ...over,
  } as ProfileFull;
}
