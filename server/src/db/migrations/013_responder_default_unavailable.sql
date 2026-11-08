-- Responders are unavailable unless they are in the mobile app (presence sets available on app sign-in).
ALTER TABLE responders ALTER COLUMN available SET DEFAULT false;
UPDATE responders SET available = false, available_manual = NULL WHERE in_app = false AND presence_pinned = false;
