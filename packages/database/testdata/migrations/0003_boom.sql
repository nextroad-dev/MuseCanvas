-- Fixture migration that always fails, and fails AFTER writing, so a runner that
-- does not roll back its transaction leaves 'boom' behind.
INSERT INTO mig_marker(k) VALUES('boom');
DO $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
