import { db } from './index'

const types = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('user','admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE user_status AS ENUM ('active','disabled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE registration_mode AS ENUM ('open','invite_only'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE model_adapter AS ENUM ('openai','seedream'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE job_status AS ENUM ('queued','running','retry_wait','succeeded','failed','canceled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE oauth_provider AS ENUM ('github','google'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`
await db().query(types)
await db().query("ALTER TYPE model_adapter ADD VALUE IF NOT EXISTS 'anthropic'")

const sql = `
CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text NOT NULL,role user_role NOT NULL DEFAULT 'user',status user_status NOT NULL DEFAULT 'active',session_version integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,deletion_requested_at timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_key ON users(lower(email)) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz);
CREATE TABLE IF NOT EXISTS otp_challenges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text NOT NULL,code_hash text NOT NULL,invitation_code_hash text,expires_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),consumed_at timestamptz);
CREATE INDEX IF NOT EXISTS otp_email_idx ON otp_challenges(lower(email),created_at DESC);
CREATE TABLE IF NOT EXISTS registration_settings (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),mode registration_mode NOT NULL DEFAULT 'open',updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid);
INSERT INTO registration_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS invitations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text,code_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),consumed_at timestamptz,revoked_at timestamptz);
ALTER TABLE invitations ALTER COLUMN email DROP NOT NULL;
CREATE TABLE IF NOT EXISTS model_configs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),display_name text NOT NULL,adapter model_adapter NOT NULL,vendor_model_id text NOT NULL,sizes jsonb NOT NULL,quality_options jsonb NOT NULL DEFAULT '[]',max_count integer NOT NULL CHECK(max_count BETWEEN 1 AND 10),watermark boolean NOT NULL DEFAULT false,concurrency_limit integer NOT NULL CHECK(concurrency_limit > 0),enabled boolean NOT NULL DEFAULT false,sort_order integer NOT NULL DEFAULT 0,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
CREATE TABLE IF NOT EXISTS generation_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_by uuid NOT NULL REFERENCES users(id),model_id uuid NOT NULL REFERENCES model_configs(id),model_name text NOT NULL,adapter model_adapter NOT NULL,vendor_model_id text NOT NULL,prompt text,size text NOT NULL,quality text,count integer NOT NULL,watermark boolean NOT NULL DEFAULT false,status job_status NOT NULL DEFAULT 'queued',idempotency_key text NOT NULL,attempt integer NOT NULL DEFAULT 0,error_code text,provider_reference_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,completed_at timestamptz,deleted_at timestamptz,UNIQUE(created_by,idempotency_key));
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS base_url text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS provider_base_url text;
CREATE INDEX IF NOT EXISTS jobs_owner_idx ON generation_jobs(created_by,created_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS assets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_by uuid NOT NULL REFERENCES users(id),job_id uuid NOT NULL REFERENCES generation_jobs(id),prompt text,object_key text NOT NULL UNIQUE,mime_type text NOT NULL,width integer NOT NULL,height integer NOT NULL,size_bytes integer NOT NULL,checksum text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
CREATE TABLE IF NOT EXISTS generation_outputs (job_id uuid NOT NULL REFERENCES generation_jobs(id),asset_id uuid NOT NULL REFERENCES assets(id),PRIMARY KEY(job_id,asset_id));
CREATE TABLE IF NOT EXISTS outbox_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_type text NOT NULL,aggregate_id uuid NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),dispatched_at timestamptz,attempts integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS deletion_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,last_error_code text,completed_at timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS deletion_active_key ON deletion_jobs(user_id) WHERE completed_at IS NULL;
CREATE TABLE IF NOT EXISTS asset_deletion_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),asset_id uuid NOT NULL REFERENCES assets(id),object_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,last_error_code text,completed_at timestamptz);
CREATE TABLE IF NOT EXISTS orphan_object_deletion_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),object_key text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0,last_error_code text,completed_at timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS asset_deletion_active_key ON asset_deletion_jobs(asset_id) WHERE completed_at IS NULL;
CREATE TABLE IF NOT EXISTS audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES users(id),action text NOT NULL,target_type text NOT NULL,target_id text NOT NULL,summary jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS oauth_identities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),provider oauth_provider NOT NULL,provider_subject text NOT NULL,email_at_link text NOT NULL,email_verified boolean NOT NULL DEFAULT true,display_name text,avatar_url text,linked_at timestamptz NOT NULL DEFAULT now(),last_login_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_provider_subject_active_key ON oauth_identities(provider,provider_subject) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS oauth_user_provider_active_key ON oauth_identities(user_id,provider) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS oauth_provider_settings (provider oauth_provider PRIMARY KEY,client_id text,client_secret_encrypted text,enabled boolean NOT NULL DEFAULT false,updated_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO oauth_provider_settings(provider) VALUES('github'),('google') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS provider_credentials (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),display_name text NOT NULL,adapter model_adapter NOT NULL,base_url text,api_key_encrypted text,api_key_fingerprint text,enabled boolean NOT NULL DEFAULT false,last_test_status text DEFAULT 'not_tested',last_test_error_code text,last_tested_at timestamptz,created_by uuid REFERENCES users(id),updated_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS provider_credential_id uuid REFERENCES provider_credentials(id);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS provider_credential_id uuid;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS provider_credential_name text;
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS model_kind text NOT NULL DEFAULT 'image';
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS preset_id text;
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS language_protocol text;
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS max_output_tokens integer;
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS temperature numeric;
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS reasoning_effort text;
ALTER TABLE model_configs ALTER COLUMN sizes DROP NOT NULL;
ALTER TABLE model_configs ALTER COLUMN max_count DROP NOT NULL;
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_kind_check CHECK(model_kind IN ('image','language')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_language_check CHECK(
  (model_kind='image' AND language_protocol IS NULL AND max_output_tokens IS NULL) OR
  (model_kind='language' AND language_protocol IN ('openai_chat','openai_responses','anthropic_messages') AND max_output_tokens > 0 AND sizes IS NULL AND max_count IS NULL)
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_protocol_adapter_check CHECK(
  model_kind='image' OR
  (adapter='openai' AND language_protocol IN ('openai_chat','openai_responses')) OR
  (adapter='anthropic' AND language_protocol='anthropic_messages')
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_reasoning_effort_check CHECK(reasoning_effort IS NULL OR reasoning_effort IN ('none','low','medium','high','xhigh')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS prompt_optimization_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  allow_user_read_final_prompt boolean NOT NULL DEFAULT false,
  language_model_config_id uuid REFERENCES model_configs(id),
  timeout_ms integer NOT NULL DEFAULT 600000 CHECK(timeout_ms = 600000),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE prompt_optimization_settings DROP COLUMN IF EXISTS max_output_chars;
ALTER TABLE prompt_optimization_settings DROP CONSTRAINT IF EXISTS prompt_optimization_settings_timeout_ms_check;
INSERT INTO prompt_optimization_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
UPDATE prompt_optimization_settings SET timeout_ms=600000,updated_at=now() WHERE singleton=true AND timeout_ms<>600000;
ALTER TABLE prompt_optimization_settings ADD CONSTRAINT prompt_optimization_settings_timeout_ms_check CHECK(timeout_ms = 600000);
UPDATE model_configs SET sizes='["1024x1024","1152x864","864x1152","1280x720","720x1280","1248x832","832x1248","1512x648","2048x2048","2304x1728","1728x2304","2848x1600","1600x2848","2496x1664","1664x2496","3136x1344","4096x4096","4704x3520","3520x4704","5504x3040","3040x5504","4992x3328","3328x4992","6240x2656"]'::jsonb,updated_at=now() WHERE preset_id='seedream-4-0' AND model_kind='image';
UPDATE model_configs SET sizes='["2048x2048","2304x1728","1728x2304","2848x1600","1600x2848","2496x1664","1664x2496","3136x1344","4096x4096","4704x3520","3520x4704","5504x3040","3040x5504","4992x3328","3328x4992","6240x2656"]'::jsonb,updated_at=now() WHERE preset_id='seedream-4-5' AND model_kind='image';

CREATE TABLE IF NOT EXISTS prompt_optimizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES generation_jobs(id),
  created_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed')),
  input_prompt text NOT NULL,
  final_prompt text,
  input_language text NOT NULL DEFAULT 'und',
  template_name_snapshot text,
  template_description_snapshot text,
  template_path_snapshot text,
  template_instruction_snapshot text,
  template_content_sha256 text,
  language_model_config_id uuid REFERENCES model_configs(id),
  language_model_name_snapshot text NOT NULL,
  language_model_vendor_id_snapshot text NOT NULL,
  language_model_protocol_snapshot text NOT NULL,
  language_model_adapter_snapshot text NOT NULL,
  language_model_base_url_snapshot text,
  language_model_max_output_tokens_snapshot integer NOT NULL,
  language_model_temperature_snapshot numeric,
  language_model_reasoning_effort_snapshot text,
  optimizer_prompt_version text,
  provider_credential_id uuid REFERENCES provider_credentials(id),
  provider_credential_name_snapshot text,
  attempt integer NOT NULL DEFAULT 0,
  error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS prompt_optimizations_owner_idx ON prompt_optimizations(created_by,created_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE prompt_optimizations ADD COLUMN IF NOT EXISTS language_model_reasoning_effort_snapshot text;
ALTER TABLE prompt_optimizations ADD COLUMN IF NOT EXISTS optimizer_prompt_version text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS phase text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS optimization_mode text NOT NULL DEFAULT 'disabled';
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS prompt_optimization_id uuid REFERENCES prompt_optimizations(id);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS provider_error jsonb;
DO $$ BEGIN ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_optimization_mode_check CHECK(optimization_mode IN ('disabled','enabled')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS max_input_images integer NOT NULL DEFAULT 0;
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_max_input_images_check CHECK(max_input_images >= 0 AND max_input_images <= 4); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_language_input_images_check CHECK(model_kind='image' OR max_input_images = 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE model_configs SET max_input_images=4,updated_at=now() WHERE preset_id IN ('openai-gpt-image-2','seedream-4-0','seedream-4-5') AND model_kind='image';

CREATE TABLE IF NOT EXISTS generation_input_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','attached','deleted')),
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  width integer,
  height integer,
  size_bytes integer NOT NULL,
  checksum text,
  attached_job_id uuid REFERENCES generation_jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  object_deleted_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS generation_input_images_owner_idx ON generation_input_images(created_by,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS generation_input_images_ttl_idx ON generation_input_images(status,expires_at) WHERE status IN ('pending','ready') AND object_deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS generation_input_images_attached_job_idx ON generation_input_images(attached_job_id) WHERE attached_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS generation_job_inputs (
  job_id uuid NOT NULL REFERENCES generation_jobs(id),
  input_image_id uuid NOT NULL UNIQUE REFERENCES generation_input_images(id),
  position integer NOT NULL CHECK(position >= 0 AND position < 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,position)
);
CREATE INDEX IF NOT EXISTS generation_job_inputs_job_idx ON generation_job_inputs(job_id,position);

CREATE TABLE IF NOT EXISTS billing_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  signup_grant bigint NOT NULL DEFAULT 0 CHECK(signup_grant >= 0),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_settings(singleton, enabled, signup_grant) VALUES(true, false, 0) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS credit_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  available_credits bigint NOT NULL DEFAULT 0 CHECK(available_credits >= 0),
  reserved_credits bigint NOT NULL DEFAULT 0 CHECK(reserved_credits >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO credit_accounts(user_id, available_credits, reserved_credits)
SELECT id, 0, 0 FROM users
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  operation text NOT NULL CHECK(operation IN ('grant','adjustment','reservation','capture','release')),
  available_delta bigint NOT NULL,
  reserved_delta bigint NOT NULL,
  available_after bigint NOT NULL CHECK(available_after >= 0),
  reserved_after bigint NOT NULL CHECK(reserved_after >= 0),
  reference_type text,
  reference_id text,
  billing_cycle integer,
  idempotency_key text UNIQUE,
  created_by uuid REFERENCES users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_ledger_user_created_idx ON credit_ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_charges (
  job_id uuid PRIMARY KEY REFERENCES generation_jobs(id),
  user_id uuid NOT NULL REFERENCES users(id),
  quoted_credits bigint NOT NULL CHECK(quoted_credits >= 0),
  state text NOT NULL CHECK(state IN ('reserved','settled','released')),
  billing_cycle integer NOT NULL DEFAULT 1 CHECK(billing_cycle >= 1),
  pricing_snapshot jsonb NOT NULL DEFAULT '{}',
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_charges_user_created_idx ON generation_charges(user_id, created_at DESC);

ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS credits_per_image bigint NOT NULL DEFAULT 0;
ALTER TABLE prompt_optimization_settings ADD COLUMN IF NOT EXISTS credits_per_job bigint NOT NULL DEFAULT 0;
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_credits_per_image_check CHECK(credits_per_image >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE prompt_optimization_settings ADD CONSTRAINT prompt_optimization_credits_per_job_check CHECK(credits_per_job >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- UNIFIED MEDIA ARCHITECTURE EXPAND / BACKFILL (Wave 1)
-- ============================================================================

-- 1. Relax legacy constraints and enums across model_configs, provider_credentials, and generation_jobs
-- Relax adapter enum columns to allow NULL for models/credentials driven by generic provider_id / plugin_id
ALTER TABLE model_configs ALTER COLUMN adapter DROP NOT NULL;
ALTER TABLE provider_credentials ALTER COLUMN adapter DROP NOT NULL;
ALTER TABLE generation_jobs ALTER COLUMN adapter DROP NOT NULL;
ALTER TABLE generation_jobs ALTER COLUMN vendor_model_id DROP NOT NULL;

-- Add provider_id, plugin_id, plugin_version to model_configs
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS provider_id text;
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS plugin_id text;
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS plugin_version text NOT NULL DEFAULT '1.0.0';

-- Relax model_configs constraints to admit 'video'
ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_configs_kind_check;
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_kind_check CHECK(model_kind IN ('image','video','language')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_configs_language_input_images_check;
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_language_input_images_check CHECK(model_kind IN ('image','video') OR max_input_images = 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_configs_protocol_adapter_check;
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_protocol_adapter_check CHECK(
  model_kind IN ('image','video') OR
  (adapter='openai' AND language_protocol IN ('openai_chat','openai_responses')) OR
  (adapter='anthropic' AND language_protocol='anthropic_messages') OR
  (provider_id IS NOT NULL)
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_configs_language_check;
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_language_check CHECK(
  (model_kind IN ('image','video') AND language_protocol IS NULL AND max_output_tokens IS NULL) OR
  (model_kind='language' AND (language_protocol IS NULL OR language_protocol IN ('openai_chat','openai_responses','anthropic_messages')) AND max_output_tokens > 0 AND sizes IS NULL AND max_count IS NULL)
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill model_configs provider_id and plugin_id
-- Note: seedream maps to provider_id 'volcengine' so Seedream (image) and Seedance (video) share credentials
UPDATE model_configs
SET provider_id = COALESCE(provider_id, CASE
      WHEN adapter = 'openai' THEN 'openai'
      WHEN adapter = 'seedream' THEN 'volcengine'
      WHEN adapter = 'anthropic' THEN 'anthropic'
      ELSE adapter::text
    END),
    plugin_id = COALESCE(plugin_id, CASE
      WHEN model_kind = 'language' THEN CASE
        WHEN adapter = 'openai' THEN 'openai-language'
        WHEN adapter = 'anthropic' THEN 'anthropic-language'
        ELSE concat(adapter::text, '-language')
      END
      WHEN model_kind = 'video' THEN CASE
        WHEN adapter = 'seedream' THEN 'seedance-video'
        ELSE concat(adapter::text, '-video')
      END
      ELSE CASE
        WHEN adapter = 'openai' THEN 'openai-image'
        WHEN adapter = 'seedream' THEN 'seedream-image'
        ELSE concat(adapter::text, '-image')
      END
    END),
    plugin_version = COALESCE(plugin_version, '1.0.0')
WHERE provider_id IS NULL OR plugin_id IS NULL;

CREATE INDEX IF NOT EXISTS model_configs_provider_idx ON model_configs(provider_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS model_configs_plugin_idx ON model_configs(plugin_id, plugin_version) WHERE deleted_at IS NULL;

-- 2. Expand provider_credentials: provider_id, schema_id, schema_version, payload_encrypted, encryption_key_id, configured_fields
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS provider_id text;
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS schema_id text;
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS payload_encrypted text;
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS encryption_key_id text;
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS configured_fields jsonb NOT NULL DEFAULT '{}';

-- Backfill provider_credentials:
-- seedream maps provider_id to 'volcengine'.
-- schema_id is explicitly set to 'legacy-api-key-v1' so the decoder knows this is an encrypted legacy string, not JSON.
UPDATE provider_credentials
SET provider_id = COALESCE(provider_id, CASE
      WHEN adapter = 'seedream' THEN 'volcengine'
      WHEN adapter = 'openai' THEN 'openai'
      WHEN adapter = 'anthropic' THEN 'anthropic'
      ELSE adapter::text
    END),
    schema_id = COALESCE(schema_id, 'legacy-api-key-v1'),
    schema_version = COALESCE(schema_version, 1),
    payload_encrypted = COALESCE(payload_encrypted, api_key_encrypted),
    configured_fields = CASE
      WHEN configured_fields = '{}'::jsonb OR configured_fields IS NULL THEN
        jsonb_strip_nulls(jsonb_build_object(
          'hasApiKey', api_key_encrypted IS NOT NULL,
          'apiKeyFingerprint', api_key_fingerprint,
          'baseUrl', base_url,
          'legacyFormat', true
        ))
      ELSE configured_fields
    END
WHERE provider_id IS NULL OR payload_encrypted IS NULL;

CREATE INDEX IF NOT EXISTS provider_credentials_provider_idx ON provider_credentials(provider_id) WHERE deleted_at IS NULL;

-- 3. Immutable model_config_revisions
CREATE TABLE IF NOT EXISTS model_config_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES model_configs(id),
  revision integer NOT NULL CHECK(revision >= 1),
  provider_id text NOT NULL,
  plugin_id text NOT NULL,
  plugin_version text NOT NULL DEFAULT '1.0.0',
  vendor_model_id text,
  base_url text,
  credential_id uuid REFERENCES provider_credentials(id),
  credential_schema_version integer,
  capabilities jsonb NOT NULL DEFAULT '{}',
  pricing jsonb NOT NULL DEFAULT '{}',
  normalized_config jsonb NOT NULL DEFAULT '{}',
  defaults jsonb NOT NULL DEFAULT '{}',
  snapshot_digest text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(model_id, revision)
);
CREATE INDEX IF NOT EXISTS model_config_revisions_model_idx ON model_config_revisions(model_id, revision DESC);
CREATE INDEX IF NOT EXISTS model_config_revisions_provider_idx ON model_config_revisions(provider_id);
CREATE INDEX IF NOT EXISTS model_config_revisions_plugin_idx ON model_config_revisions(plugin_id, plugin_version);
CREATE INDEX IF NOT EXISTS model_config_revisions_digest_idx ON model_config_revisions(snapshot_digest);

-- Add latest_revision_id linkage to model_configs
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS latest_revision_id uuid REFERENCES model_config_revisions(id);

-- Deterministic backfill of initial model_config_revisions for existing model_configs
DO $$
DECLARE
  rec RECORD;
  rev_id uuid;
  prov_id text;
  p_id text;
  cap jsonb;
  prc jsonb;
  norm jsonb;
  dflt jsonb;
  dig text;
  cred_schema_ver integer;
BEGIN
  FOR rec IN SELECT m.*, pc.schema_version AS cred_schema_ver
             FROM model_configs m
             LEFT JOIN provider_credentials pc ON pc.id = m.provider_credential_id
             WHERE m.deleted_at IS NULL LOOP
    IF NOT EXISTS (SELECT 1 FROM model_config_revisions WHERE model_id = rec.id) THEN
      prov_id := COALESCE(rec.provider_id, CASE
        WHEN rec.adapter = 'seedream' THEN 'volcengine'
        WHEN rec.adapter = 'openai' THEN 'openai'
        WHEN rec.adapter = 'anthropic' THEN 'anthropic'
        ELSE rec.adapter::text
      END);

      p_id := COALESCE(rec.plugin_id, CASE
        WHEN rec.model_kind = 'language' THEN CASE
          WHEN rec.adapter = 'openai' THEN 'openai-language'
          WHEN rec.adapter = 'anthropic' THEN 'anthropic-language'
          ELSE concat(rec.adapter::text, '-language')
        END
        WHEN rec.model_kind = 'video' THEN CASE
          WHEN rec.adapter = 'seedream' THEN 'seedance-video'
          ELSE concat(rec.adapter::text, '-video')
        END
        ELSE CASE
          WHEN rec.adapter = 'openai' THEN 'openai-image'
          WHEN rec.adapter = 'seedream' THEN 'seedream-image'
          ELSE concat(rec.adapter::text, '-image')
        END
      END);

      cap := jsonb_build_object(
        'mediaKind', rec.model_kind,
        'modes', CASE
          WHEN rec.model_kind = 'video' THEN jsonb_build_array('text_to_video', 'image_to_video')
          WHEN rec.model_kind = 'image' THEN jsonb_build_array('text_to_image', 'image_to_image')
          ELSE jsonb_build_array()
        END,
        'sizes', COALESCE(rec.sizes, '[]'::jsonb),
        'qualityOptions', COALESCE(rec.quality_options, '[]'::jsonb),
        'maxCount', COALESCE(rec.max_count, 1),
        'maxInputImages', COALESCE(rec.max_input_images, 0)
      );

      prc := jsonb_build_object(
        'scheme', 'per_image_v1',
        'creditsPerImage', COALESCE(rec.credits_per_image, 0)
      );

      norm := jsonb_strip_nulls(jsonb_build_object(
        'vendorModelId', rec.vendor_model_id,
        'baseUrl', rec.base_url,
        'concurrencyLimit', rec.concurrency_limit,
        'watermark', rec.watermark,
        'sortOrder', rec.sort_order,
        'modelKind', rec.model_kind,
        'languageProtocol', rec.language_protocol,
        'maxOutputTokens', rec.max_output_tokens,
        'temperature', rec.temperature,
        'reasoningEffort', rec.reasoning_effort
      ));

      dflt := jsonb_strip_nulls(jsonb_build_object(
        'vendorModelId', rec.vendor_model_id,
        'watermark', rec.watermark,
        'concurrencyLimit', rec.concurrency_limit
      ));

      cred_schema_ver := COALESCE(rec.cred_schema_ver, 1);

      dig := encode(digest(concat(rec.id::text, ':', prov_id, ':', p_id, ':', COALESCE(rec.vendor_model_id, ''), ':', cap::text, ':', prc::text), 'sha256'), 'hex');

      INSERT INTO model_config_revisions(
        model_id, revision, provider_id, plugin_id, plugin_version,
        vendor_model_id, base_url, credential_id, credential_schema_version,
        capabilities, pricing, normalized_config, defaults, snapshot_digest, created_by, created_at
      ) VALUES (
        rec.id, 1, prov_id, p_id, '1.0.0',
        rec.vendor_model_id, rec.base_url, rec.provider_credential_id, cred_schema_ver,
        cap, prc, norm, dflt, dig, rec.created_by, rec.created_at
      )
      RETURNING id INTO rev_id;

      UPDATE model_configs SET latest_revision_id = rev_id WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;

-- 4. Expand generation_jobs and relax image-only required constraints
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS media_kind text NOT NULL DEFAULT 'image';
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS model_revision_id uuid REFERENCES model_config_revisions(id);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS provider_id text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS plugin_id text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS plugin_version text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS normalized_request jsonb;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS request_digest text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 100);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;

-- Relax image-only required columns (size, count) for future video jobs
ALTER TABLE generation_jobs ALTER COLUMN size DROP NOT NULL;
ALTER TABLE generation_jobs ALTER COLUMN count DROP NOT NULL;

DO $$ BEGIN ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_media_kind_check CHECK(media_kind IN ('image','video')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_image_requirements_check CHECK(
  media_kind <> 'image' OR (size IS NOT NULL AND count IS NOT NULL)
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Uniqueness / index for request digest
CREATE INDEX IF NOT EXISTS generation_jobs_request_digest_idx ON generation_jobs(created_by, request_digest) WHERE request_digest IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS generation_jobs_provider_idx ON generation_jobs(provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS generation_jobs_plugin_idx ON generation_jobs(plugin_id, plugin_version) WHERE plugin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS generation_jobs_status_phase_idx ON generation_jobs(status, phase) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS generation_jobs_cancel_requested_idx ON generation_jobs(cancel_requested_at) WHERE cancel_requested_at IS NOT NULL AND status IN ('queued','running');

-- Backfill existing generation_jobs
UPDATE generation_jobs
SET provider_id = COALESCE(provider_id, CASE
      WHEN adapter = 'openai' THEN 'openai'
      WHEN adapter = 'seedream' THEN 'volcengine'
      ELSE adapter::text
    END),
    plugin_id = COALESCE(plugin_id, CASE
      WHEN adapter = 'openai' THEN 'openai-image'
      WHEN adapter = 'seedream' THEN 'seedream-image'
      ELSE concat(adapter::text, '-image')
    END),
    plugin_version = COALESCE(plugin_version, '1.0.0'),
    media_kind = COALESCE(media_kind, 'image'),
    normalized_request = CASE
      WHEN normalized_request IS NULL THEN
        jsonb_strip_nulls(jsonb_build_object(
          'modelId', model_id,
          'prompt', prompt,
          'parameters', jsonb_strip_nulls(jsonb_build_object(
            'size', size,
            'quality', quality,
            'count', count,
            'watermark', watermark
          ))
        ))
      ELSE normalized_request
    END,
    request_digest = COALESCE(request_digest, encode(digest(concat(model_id::text, ':', COALESCE(prompt, ''), ':', COALESCE(size, ''), ':', COALESCE(count::text, '1')), 'sha256'), 'hex'))
WHERE plugin_id IS NULL OR request_digest IS NULL;

-- 5. Generic media_uploads and generation_job_inputs role / position linkage
CREATE TABLE IF NOT EXISTS media_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES users(id),
  media_kind text NOT NULL DEFAULT 'image' CHECK(media_kind IN ('image','video')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','attached','deleted')),
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  width integer,
  height integer,
  duration_seconds numeric,
  fps numeric,
  size_bytes integer NOT NULL,
  checksum text,
  attached_job_id uuid REFERENCES generation_jobs(id),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  object_deleted_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS media_uploads_owner_idx ON media_uploads(created_by, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS media_uploads_ttl_idx ON media_uploads(status, expires_at) WHERE status IN ('pending','ready') AND object_deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS media_uploads_attached_job_idx ON media_uploads(attached_job_id) WHERE attached_job_id IS NOT NULL;

-- Expand generation_input_images with media_kind for compatibility
ALTER TABLE generation_input_images ADD COLUMN IF NOT EXISTS media_kind text NOT NULL DEFAULT 'image';

-- Expand generation_job_inputs to support generic upload_id and role
ALTER TABLE generation_job_inputs ADD COLUMN IF NOT EXISTS upload_id uuid REFERENCES media_uploads(id);
ALTER TABLE generation_job_inputs ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'prompt_image';
DO $$ BEGIN ALTER TABLE generation_job_inputs ADD CONSTRAINT generation_job_inputs_role_check CHECK(role IN ('prompt_image','reference_image','first_frame','last_frame','source_video')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE generation_job_inputs ALTER COLUMN input_image_id DROP NOT NULL;

-- Relax position constraint from < 4 to >= 0 for extensible multi-slot inputs (e.g. video / multi-frame)
ALTER TABLE generation_job_inputs DROP CONSTRAINT IF EXISTS generation_job_inputs_position_check;
DO $$ BEGIN ALTER TABLE generation_job_inputs ADD CONSTRAINT generation_job_inputs_position_check CHECK(position >= 0 AND position < 32); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Deterministic backfill from generation_input_images into media_uploads
INSERT INTO media_uploads(id, created_by, media_kind, status, object_key, mime_type, width, height, size_bytes, checksum, attached_job_id, created_at, updated_at, expires_at, object_deleted_at, deleted_at)
SELECT id, created_by, 'image', status, object_key, mime_type, width, height, size_bytes, checksum, attached_job_id, created_at, updated_at, expires_at, object_deleted_at, deleted_at
FROM generation_input_images
ON CONFLICT (id) DO NOTHING;

-- Backfill generation_job_inputs upload_id from input_image_id
UPDATE generation_job_inputs
SET upload_id = input_image_id
WHERE upload_id IS NULL AND input_image_id IS NOT NULL;

-- Enforce uniqueness on generation_job_inputs(upload_id) where upload_id is present
CREATE UNIQUE INDEX IF NOT EXISTS generation_job_inputs_upload_id_unique ON generation_job_inputs(upload_id) WHERE upload_id IS NOT NULL;

-- 6. provider_runs table:
-- operation_state includes: 'submitting','submission_unknown','waiting','importing','canceling','succeeded','failed','canceled'
-- supports provider_accepted_at, capacity reservation lifecycle vs worker lease, encrypted serialized operation/output state
CREATE TABLE IF NOT EXISTS provider_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES generation_jobs(id),
  attempt integer NOT NULL DEFAULT 1 CHECK(attempt >= 1),
  provider_id text NOT NULL DEFAULT 'legacy',
  plugin_id text NOT NULL,
  plugin_version text NOT NULL DEFAULT '1.0.0',
  operation_state text NOT NULL DEFAULT 'submitting' CHECK(operation_state IN ('submitting','submission_unknown','waiting','importing','canceling','succeeded','failed','canceled')),
  client_token text NOT NULL,
  remote_id text,
  state_revision integer NOT NULL DEFAULT 1 CHECK(state_revision >= 1),
  next_action_at timestamptz,
  -- Capacity reservation lifecycle: pending | reserved | released
  capacity_state text NOT NULL DEFAULT 'pending' CHECK(capacity_state IN ('pending','reserved','released')),
  capacity_reservation_id text,
  capacity_reserved_at timestamptz,
  capacity_released_at timestamptz,
  -- Worker execution lease lifecycle
  worker_lease_token text,
  worker_lease_expires_at timestamptz,
  -- Serialized operation state (untrusted / encrypted envelope to prevent raw signed URL leaks)
  encrypted_state_payload text,
  encrypted_state_key_id text,
  -- Manifest metadata (descriptive manifest without signed URLs)
  output_manifest jsonb,
  error jsonb,
  submitted_at timestamptz,
  provider_accepted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, attempt),
  UNIQUE(client_token)
);
CREATE INDEX IF NOT EXISTS provider_runs_active_idx ON provider_runs(operation_state, next_action_at) WHERE operation_state IN ('submitting','submission_unknown','waiting','importing','canceling');
CREATE INDEX IF NOT EXISTS provider_runs_lease_idx ON provider_runs(worker_lease_token, worker_lease_expires_at) WHERE worker_lease_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS provider_runs_remote_idx ON provider_runs(plugin_id, remote_id) WHERE remote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS provider_runs_job_idx ON provider_runs(job_id, attempt DESC);
CREATE INDEX IF NOT EXISTS provider_runs_capacity_active_idx ON provider_runs(provider_id, plugin_id) WHERE capacity_state = 'reserved' AND operation_state NOT IN ('succeeded','failed','canceled');

-- 7. Deterministic output-ingestion table with run/output identity, object key, multipart upload id, checksum/bytes/attached timestamps
-- Remote outputs are located securely via encrypted provider_runs state and referenced by (run_id, output_index)
CREATE TABLE IF NOT EXISTS output_ingestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES generation_jobs(id),
  run_id uuid NOT NULL REFERENCES provider_runs(id),
  output_index integer NOT NULL DEFAULT 0 CHECK(output_index >= 0),
  media_kind text NOT NULL DEFAULT 'image' CHECK(media_kind IN ('image','video')),
  storage_object_key text NOT NULL UNIQUE,
  multipart_upload_id text,
  checksum text,
  size_bytes bigint,
  mime_type text,
  ingestion_state text NOT NULL DEFAULT 'pending' CHECK(ingestion_state IN ('pending','downloading','uploading','verifying','persisted','failed')),
  asset_id uuid REFERENCES assets(id),
  metadata jsonb NOT NULL DEFAULT '{}',
  error jsonb,
  download_started_at timestamptz,
  download_completed_at timestamptz,
  attached_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, output_index)
);
CREATE INDEX IF NOT EXISTS output_ingestions_job_idx ON output_ingestions(job_id, output_index);
CREATE INDEX IF NOT EXISTS output_ingestions_state_idx ON output_ingestions(ingestion_state) WHERE ingestion_state NOT IN ('persisted','failed');

-- 8. assets media_kind plus video metadata (duration, fps, codec, audio, poster)
-- Relax width and height NOT NULL constraints for video metadata unknown at ingest
ALTER TABLE assets ALTER COLUMN width DROP NOT NULL;
ALTER TABLE assets ALTER COLUMN height DROP NOT NULL;

ALTER TABLE assets ADD COLUMN IF NOT EXISTS media_kind text NOT NULL DEFAULT 'image';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS duration_seconds numeric;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS fps numeric;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS codec text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS has_audio boolean;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS poster_asset_id uuid REFERENCES assets(id);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS poster_object_key text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

DO $$ BEGIN ALTER TABLE assets ADD CONSTRAINT assets_media_kind_check CHECK(media_kind IN ('image','video')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS assets_media_kind_idx ON assets(media_kind, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS assets_poster_idx ON assets(poster_asset_id) WHERE poster_asset_id IS NOT NULL;

-- 9. outbox_events dedupe key and index
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_dedupe_key_idx ON outbox_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
`
await db().query(sql)
await db().query('DROP TABLE IF EXISTS smtp_settings')
console.log('database migration complete')
await db().end()
