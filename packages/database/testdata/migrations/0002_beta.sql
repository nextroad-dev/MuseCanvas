-- Fixture migration: a second applied step, so a later failure has something to
-- roll past.
INSERT INTO mig_marker(k) VALUES('beta') ON CONFLICT DO NOTHING;
