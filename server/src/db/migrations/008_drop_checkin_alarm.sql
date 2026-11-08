-- Welfare check-ins no longer have a final-try alarm (the app only delivers the check-in; the case becomes silent at deadline_at).
alter table checkins drop column if exists alarm_at;
