-- Fixture migration after the failing one: must never run.
INSERT INTO mig_marker(k) VALUES('delta') ON CONFLICT DO NOTHING;
