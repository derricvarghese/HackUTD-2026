-- Dispatch agent: local facilities (hospitals, shelters, fire stations from OpenStreetMap), agent runs (full step trace) and proposals (human approval).
CREATE TABLE facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('hospital','shelter','fire_station')),
  name text NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  osm_id text,
  tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX facilities_event_idx ON facilities (event_id, kind);
CREATE UNIQUE INDEX facilities_osm_uniq ON facilities (event_id, osm_id) WHERE osm_id IS NOT NULL;

-- state of the background Overpass ingestion per event
ALTER TABLE events ADD COLUMN facilities_bbox text;
ALTER TABLE events ADD COLUMN facilities_fetched_at timestamptz;
ALTER TABLE events ADD COLUMN facilities_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN facilities_source text;

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sos_id uuid NOT NULL REFERENCES sos(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','complete','failed','cancelled')),
  trigger text NOT NULL,
  model text,
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  assessment jsonb,
  signals jsonb,
  error text,
  tokens jsonb,
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX agent_runs_sos_idx ON agent_runs (sos_id, created_at DESC);
CREATE INDEX agent_runs_status_idx ON agent_runs (status) WHERE status IN ('queued','running');

CREATE TABLE agent_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sos_id uuid NOT NULL REFERENCES sos(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'dispatch',
  responder_id uuid REFERENCES responders(id) ON DELETE SET NULL,
  eta_minutes integer,
  equipment jsonb NOT NULL DEFAULT '[]'::jsonb,
  facility jsonb,
  victim_message text,
  notes text,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','superseded','expired')),
  decided_by uuid REFERENCES responders(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX agent_proposals_sos_idx ON agent_proposals (sos_id, created_at DESC);
-- at most one active (queued or running) run per case; the partial unique index is the arbiter between server instances
CREATE UNIQUE INDEX agent_runs_one_active ON agent_runs (sos_id) WHERE status IN ('queued','running');
