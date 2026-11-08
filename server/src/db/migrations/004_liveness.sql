-- Automatic liveness (heartbeats) + welfare check-ins.
ALTER TABLE devices ADD COLUMN last_transport text;
ALTER TABLE devices ADD COLUMN last_network text;
ALTER TABLE devices ADD COLUMN last_battery integer;
ALTER TABLE devices ADD COLUMN last_peers_nearby integer;
ALTER TABLE devices ADD COLUMN last_gateway boolean;

ALTER TABLE heartbeats ADD COLUMN transport text;
ALTER TABLE heartbeats ADD COLUMN network text;
ALTER TABLE heartbeats ADD COLUMN peers_nearby integer;
ALTER TABLE heartbeats ADD COLUMN gateway boolean;
ALTER TABLE heartbeats ADD COLUMN open_sos_ids jsonb;

-- silence_boost   = +10 per missed welfare check-in (+10 more when unresponsive), cap 30
-- contact_boost   = heartbeat-gap escalation (+10 at the threshold, +10 per further interval), cap 30
-- urgent_boost    = "I need help urgently" replies, +15 each, cap 30
ALTER TABLE sos ADD COLUMN contact_boost integer NOT NULL DEFAULT 0;
ALTER TABLE sos ADD COLUMN urgent_boost integer NOT NULL DEFAULT 0;
ALTER TABLE sos ADD COLUMN welfare_missed integer NOT NULL DEFAULT 0;

ALTER TABLE checkins ADD COLUMN alarm_at timestamptz;
ALTER TABLE checkins ADD COLUMN kind text NOT NULL DEFAULT 'welfare';
ALTER TABLE checkins DROP CONSTRAINT IF EXISTS checkins_response_check;
ALTER TABLE checkins ADD CONSTRAINT checkins_response_check
  CHECK (response IN ('ok','need_help','other','still_here','no_longer_need_help','need_urgent_help'));
