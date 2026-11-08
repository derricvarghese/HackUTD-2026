-- A missed welfare check-in stays the single active check-in (overdue) and is re-delivered as reminders instead of spawning new check-ins.
-- Reminder state lives here (not in memory) so a restart neither loses nor repeats reminders.
ALTER TABLE checkins ADD COLUMN reminder_count integer NOT NULL DEFAULT 0;
ALTER TABLE checkins ADD COLUMN last_reminded_at timestamptz;
-- sos.welfare_missed is now 0 or 1 (the active check-in is overdue); fold old counters into that.
UPDATE sos SET welfare_missed = 1 WHERE welfare_missed > 1;
-- sos.silence_boost: +10 when the deadline passes (+20 if still heartbeating), then +5 per further 10 min overdue, cap 30.
