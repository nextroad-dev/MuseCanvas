-- Fixture migration for the runner tests. Creates a marker table and claims a row.
CREATE TABLE IF NOT EXISTS mig_marker (k text PRIMARY KEY);
INSERT INTO mig_marker(k) VALUES('alpha') ON CONFLICT DO NOTHING;
