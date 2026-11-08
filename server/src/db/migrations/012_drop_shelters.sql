-- Remove shelters from facilities (only hospitals and fire stations are tracked).
DELETE FROM facilities WHERE kind = 'shelter';
ALTER TABLE facilities DROP CONSTRAINT IF EXISTS facilities_kind_check;
ALTER TABLE facilities ADD CONSTRAINT facilities_kind_check CHECK (kind IN ('hospital', 'fire_station'));
