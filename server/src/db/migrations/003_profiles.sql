-- Victim identity profiles (personal data). One row per device.
-- Queryable in clear text on purpose: full_name / name_norm / preferred_name / birth_year / vuln_flags (shown to every dashboard user in coarse form).
-- Everything else (medical, address, contact, phone, appearance, household, notes, languages) lives in `enc`: AES-256-GCM, see src/crypto/profileCrypto.ts.
CREATE TABLE profiles (
  device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  name_norm text NOT NULL,
  preferred_name text,
  birth_year integer,
  vuln_flags text[] NOT NULL DEFAULT '{}',   -- non-age flags derived at write time (mobility, medical, oxygen, sensory, cognitive); age flags are derived at read time
  enc bytea NOT NULL,                        -- nonce(12) | tag(16) | ciphertext
  enc_version smallint NOT NULL DEFAULT 1,
  consent_version text NOT NULL,
  consent_accepted_at timestamptz NOT NULL,
  profile_version integer NOT NULL DEFAULT 1,
  synthetic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_name_norm_idx ON profiles (name_norm);
CREATE INDEX profiles_updated_idx ON profiles (updated_at);
CREATE INDEX profiles_synthetic_idx ON profiles (synthetic) WHERE synthetic;

-- Identity hint carried by an offline (mesh) SOS until the full profile syncs: {full_name, age_range?, vulnerability_flags?, profile_version, synthetic?}
ALTER TABLE sos ADD COLUMN profile_summary jsonb;
