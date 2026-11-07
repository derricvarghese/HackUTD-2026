-- Beacon schema (server-design.md section 5). Timestamps are truncated to ms so they round-trip through JS Dates (cursor pagination).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','purged')),
  region jsonb,
  retention_days integer NOT NULL DEFAULT 7,
  heartbeat_interval_s integer NOT NULL DEFAULT 300,
  silence_threshold_s integer NOT NULL DEFAULT 1200,
  synthetic boolean NOT NULL DEFAULT false,
  closed_at timestamptz,
  purge_at timestamptz,
  purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
-- one active event at a time
CREATE UNIQUE INDEX events_one_active ON events ((status)) WHERE status = 'active';

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key text NOT NULL UNIQUE,
  sender_hash text NOT NULL,
  platform text NOT NULL DEFAULT 'android',
  app_version text,
  display_name text,
  push_token text,
  flagged boolean NOT NULL DEFAULT false,
  flag_reason text,
  last_seen_at timestamptz,
  last_heartbeat_at timestamptz,
  heartbeat_status text NOT NULL DEFAULT 'unknown'
    CHECK (heartbeat_status IN ('active','quiet','distress','stopped','unknown')),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX devices_heartbeat_status_idx ON devices (heartbeat_status);
CREATE INDEX devices_sender_hash_idx ON devices (sender_hash);

CREATE TABLE responders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('responder','volunteer','admin')),
  skills text[] NOT NULL DEFAULT '{}',
  organization text,
  phone text,
  available boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  lat double precision,
  lng double precision,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  responder_id uuid NOT NULL REFERENCES responders(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX refresh_tokens_responder_idx ON refresh_tokens (responder_id);

CREATE TABLE sos (
  id uuid PRIMARY KEY,                       -- client-generated UUIDv7
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  sender_hash text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('mesh','app')),
  category text NOT NULL CHECK (category IN ('injured','trapped','need_water_meds','safe','other')),
  status text NOT NULL DEFAULT 'reported'
    CHECK (status IN ('reported','assigned','en_route','on_scene','resolved','merged','closed')),
  lat double precision,
  lng double precision,
  geohash7 text,
  approx_lat double precision NOT NULL,
  approx_lng double precision NOT NULL,
  text text,
  people_count integer,
  trapped boolean NOT NULL DEFAULT false,
  water_rising boolean NOT NULL DEFAULT false,
  injured boolean NOT NULL DEFAULT false,
  accuracy_m double precision,
  score integer NOT NULL DEFAULT 0,
  score_override integer,
  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('low','medium','high')),
  silent boolean NOT NULL DEFAULT false,
  silent_since timestamptz,
  merged_into uuid REFERENCES sos(id) ON DELETE SET NULL,
  duplicate_count integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  last_heard_at timestamptz NOT NULL,
  hop_count integer NOT NULL DEFAULT 0,
  max_hops integer NOT NULL DEFAULT 0,
  hop_path text[] NOT NULL DEFAULT '{}',
  gateway_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  original_created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  has_voice_note boolean NOT NULL DEFAULT false,
  synthetic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX sos_event_status_score_idx ON sos (event_id, status, score DESC);
CREATE INDEX sos_geohash7_idx ON sos (geohash7);
CREATE INDEX sos_last_heard_idx ON sos (last_heard_at);
CREATE INDEX sos_updated_idx ON sos (updated_at);
CREATE INDEX sos_device_idx ON sos (device_id);
CREATE INDEX sos_merged_into_idx ON sos (merged_into);
CREATE INDEX sos_text_fts_idx ON sos USING GIN (to_tsvector('simple', coalesce(text, '')));

-- every raw incoming copy (including duplicates) so merges are reversible
CREATE TABLE sos_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sos_id uuid NOT NULL REFERENCES sos(id) ON DELETE CASCADE,
  channel text NOT NULL,
  envelope jsonb,
  text text,
  hop_count integer NOT NULL DEFAULT 0,
  max_hops integer NOT NULL DEFAULT 0,
  hop_path text[] NOT NULL DEFAULT '{}',
  gateway_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  original_created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX sos_reports_sos_idx ON sos_reports (sos_id, received_at);

CREATE TABLE triage_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sos_id uuid NOT NULL REFERENCES sos(id) ON DELETE CASCADE,
  score integer NOT NULL,
  confidence text NOT NULL,
  summary text,
  tier text,
  reasons jsonb NOT NULL DEFAULT '[]',
  extracted jsonb NOT NULL DEFAULT '{}',
  llm_used boolean NOT NULL DEFAULT false,
  model text,
  scored_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX triage_results_sos_idx ON triage_results (sos_id, scored_at DESC);

CREATE TABLE sos_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sos_id uuid NOT NULL REFERENCES sos(id) ON DELETE CASCADE,
  type text NOT NULL,
  actor_kind text NOT NULL DEFAULT 'system' CHECK (actor_kind IN ('system','responder','victim')),
  actor_id text,
  data jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX sos_events_sos_idx ON sos_events (sos_id, at);

CREATE TABLE checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sos_id uuid NOT NULL REFERENCES sos(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'app',
  message text,
  sent_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  deadline_at timestamptz NOT NULL,
  responded_at timestamptz,
  response text CHECK (response IN ('ok','need_help','other')),
  response_text text,
  attempt integer NOT NULL DEFAULT 1,
  missed boolean NOT NULL DEFAULT false,
  cancelled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX checkins_sos_idx ON checkins (sos_id, sent_at);
CREATE INDEX checkins_pending_idx ON checkins (deadline_at) WHERE responded_at IS NULL AND NOT cancelled;

CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sos_id uuid NOT NULL REFERENCES sos(id) ON DELETE CASCADE,
  responder_id uuid NOT NULL REFERENCES responders(id),
  status text NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned','en_route','on_scene','resolved','released','cancelled')),
  eta_minutes integer,
  eta_at timestamptz,
  outcome text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
-- exactly one active claim per case
CREATE UNIQUE INDEX assignments_one_active_per_sos ON assignments (sos_id)
  WHERE status IN ('assigned','en_route','on_scene');
CREATE INDEX assignments_responder_idx ON assignments (responder_id, status);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  sender_hash text NOT NULL,
  kind text NOT NULL,
  description text,
  capacity integer,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','completed','withdrawn')),
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  approx_lat double precision NOT NULL,
  approx_lng double precision NOT NULL,
  radius_km double precision NOT NULL DEFAULT 3,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);

CREATE TABLE offer_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  sos_id uuid NOT NULL REFERENCES sos(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','accepted','declined','completed')),
  distance_km double precision NOT NULL,
  score double precision,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  UNIQUE (offer_id, sos_id)
);

CREATE TABLE heartbeats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  approx_lat double precision NOT NULL,
  approx_lng double precision NOT NULL,
  radius_m integer NOT NULL DEFAULT 1000,
  battery_pct integer,
  charging boolean,
  moving boolean,
  seq integer,
  hop_count integer NOT NULL DEFAULT 0,
  hop_path text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX heartbeats_device_received_idx ON heartbeats (device_id, received_at DESC);

CREATE TABLE silent_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('quiet','distress')),
  neighbors_active integer NOT NULL DEFAULT 0,
  open_sos_id uuid REFERENCES sos(id) ON DELETE SET NULL,
  priority_score integer NOT NULL DEFAULT 0,
  reason text,
  acknowledged boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  flagged_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);

CREATE TABLE deadzones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  center_lat double precision NOT NULL,
  center_lng double precision NOT NULL,
  radius_m integer NOT NULL DEFAULT 700,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','being_checked','dismissed')),
  reason text,
  last_activity_at timestamptz,
  neighbor_case_count integer NOT NULL DEFAULT 0,
  detected_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);

CREATE TABLE mesh_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('delivered','checkin_request','status_update')),
  sos_id uuid REFERENCES sos(id) ON DELETE CASCADE,
  checkin_id uuid,
  body jsonb NOT NULL DEFAULT '{}',
  envelope jsonb NOT NULL,
  max_hops integer NOT NULL DEFAULT 5,
  expires_at timestamptz NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX mesh_outbox_created_idx ON mesh_outbox (created_at);

CREATE TABLE rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reason text NOT NULL,
  device_id uuid,
  envelope_id uuid,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX rejections_reason_idx ON rejections (reason, created_at);

CREATE TABLE voice_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sos_id uuid NOT NULL UNIQUE REFERENCES sos(id) ON DELETE CASCADE,
  mime text NOT NULL,
  size_bytes integer NOT NULL,
  data bytea,
  transcript text,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
