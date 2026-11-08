-- Case photos (JPEG/PNG, metadata stripped by the server), stored as bytea like voice notes.
-- id is the client-generated UUID so retried uploads are idempotent.
CREATE TABLE case_images (
  id uuid PRIMARY KEY,
  sos_id uuid NOT NULL REFERENCES sos(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE CASCADE,          -- the case's device (erasing the device erases its photos)
  uploaded_by_kind text NOT NULL CHECK (uploaded_by_kind IN ('device','responder')),
  responder_id uuid REFERENCES responders(id) ON DELETE SET NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png')),
  bytes integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  caption text,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX case_images_sos_idx ON case_images (sos_id, created_at);
CREATE INDEX case_images_device_idx ON case_images (device_id);

-- informational hint from an offline SOS ("N photos will follow"); never authoritative
ALTER TABLE sos ADD COLUMN image_hint integer;
