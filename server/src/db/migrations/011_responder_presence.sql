-- Responder presence: only the mobile app puts someone "in the field". Dashboard-only users never change these.
ALTER TABLE responders ADD COLUMN in_app boolean NOT NULL DEFAULT false;
ALTER TABLE responders ADD COLUMN last_app_seen_at timestamptz;
ALTER TABLE responders ADD COLUMN location_updated_at timestamptz;
-- false while the responder explicitly switched availability off during the current app session (cleared on offline)
ALTER TABLE responders ADD COLUMN available_manual boolean;
-- demo seeding pins fake presence so the presence sweep leaves it alone until a real app touches the account
ALTER TABLE responders ADD COLUMN presence_pinned boolean NOT NULL DEFAULT false;
UPDATE responders SET location_updated_at = last_seen_at WHERE lat IS NOT NULL AND lng IS NOT NULL;
CREATE INDEX responders_in_app_idx ON responders (last_app_seen_at) WHERE in_app;
