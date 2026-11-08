-- Asynchronous AI triage. A case is stored and shown at once with its rules score (`provisional`); a background job then asks the LLM
-- and flips it to `complete` (or `failed` after the retries are used up; a slow sweep keeps retrying failed cases).
--   provisional = rules score shown, AI job waiting     pending = AI job claimed and running
--   complete    = AI result applied                     failed  = AI unavailable, rules score stands
-- Existing rows predate the pipeline and count as complete.
ALTER TABLE sos ADD COLUMN triage_status text NOT NULL DEFAULT 'complete' CHECK (triage_status IN ('provisional','pending','complete','failed'));
ALTER TABLE sos ADD COLUMN triage_attempts integer NOT NULL DEFAULT 0;      -- LLM attempts used in the current round
ALTER TABLE sos ADD COLUMN triage_sweeps integer NOT NULL DEFAULT 0;       -- slow-sweep rounds already spent on a failed case
ALTER TABLE sos ADD COLUMN triage_gen integer NOT NULL DEFAULT 0;          -- bumped whenever the triage inputs change; a stale AI result is discarded
ALTER TABLE sos ADD COLUMN triage_updated_at timestamptz;                  -- when the last AI pass completed
ALTER TABLE sos ADD COLUMN triage_requested_at timestamptz NOT NULL DEFAULT now(); -- when the current AI pass was requested (queue age)
ALTER TABLE sos ADD COLUMN triage_next_at timestamptz NOT NULL DEFAULT now();      -- not before this instant (retry backoff)
ALTER TABLE sos ADD COLUMN triage_claimed_at timestamptz;                  -- set while pending; a stale claim (crashed instance) can be taken over

CREATE INDEX sos_triage_queue_idx ON sos (triage_next_at) WHERE triage_status IN ('provisional','pending','failed');
