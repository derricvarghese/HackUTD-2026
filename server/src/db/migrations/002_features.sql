-- Build-order steps 5-7: silence boosts, demo flags, dead-zone cells, silent-device notes.
ALTER TABLE sos ADD COLUMN silence_boost integer NOT NULL DEFAULT 0;     -- +10 per missed check-in attempt
ALTER TABLE sos ADD COLUMN heartbeat_boost integer NOT NULL DEFAULT 0;   -- device went silent with this case open
ALTER TABLE devices ADD COLUMN synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE silent_devices ADD COLUMN note text;
ALTER TABLE deadzones ADD COLUMN cell_key text;
ALTER TABLE deadzones ADD COLUMN note text;
CREATE UNIQUE INDEX deadzones_event_cell_idx ON deadzones (event_id, cell_key);
CREATE INDEX sos_synthetic_idx ON sos (synthetic) WHERE synthetic;
CREATE INDEX heartbeats_event_idx ON heartbeats (event_id, device_id);
CREATE INDEX mesh_outbox_expires_idx ON mesh_outbox (expires_at);
CREATE INDEX offers_status_idx ON offers (status);
