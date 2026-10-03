-- provider_plugin_packages
-- Zip plugin packages (MuseCanvas-Connector wiki/plugin-package-spec.md §5.2).
-- A plugin is now uploaded as one .zip carrying manifest.json, the single entry
-- .mjs bundle and optional docs/icon. The API parses and validates the zip; the
-- worker never sees it. object_key / artifact_sha256 / artifact_size_bytes keep
-- their meaning (the entry bundle), so the worker's integrity check is unchanged.
--
-- package_format: 'mjs' for the legacy manifest + file upload, 'zip-v1' for a
-- zip package. package_object_key / package_sha256 address the original zip
-- (archive and re-download only, never executed). package_files lists the zip's
-- entries as [{ path, sizeBytes, sha256 }]; package_meta holds the manifest's
-- package block display fields plus the icon's private storage key. README,
-- CHANGELOG and LICENSE text (each <= 256 KiB) live in the row itself.

ALTER TABLE provider_plugins ADD COLUMN IF NOT EXISTS package_format text NOT NULL DEFAULT 'mjs';
DO $$ BEGIN ALTER TABLE provider_plugins ADD CONSTRAINT provider_plugins_package_format_check CHECK(package_format IN ('mjs','zip-v1')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE provider_plugins ADD COLUMN IF NOT EXISTS package_object_key text;
ALTER TABLE provider_plugins ADD COLUMN IF NOT EXISTS package_sha256 text;
ALTER TABLE provider_plugins ADD COLUMN IF NOT EXISTS package_files jsonb NOT NULL DEFAULT '[]';
ALTER TABLE provider_plugins ADD COLUMN IF NOT EXISTS package_meta jsonb NOT NULL DEFAULT '{}';
ALTER TABLE provider_plugins ADD COLUMN IF NOT EXISTS readme text;
ALTER TABLE provider_plugins ADD COLUMN IF NOT EXISTS changelog text;
ALTER TABLE provider_plugins ADD COLUMN IF NOT EXISTS license_text text;
