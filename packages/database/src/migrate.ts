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
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS code_encrypted text;
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
ALTER TABLE audit_logs ALTER COLUMN actor_id DROP NOT NULL;
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

      dig := encode(digest(concat(rec.id::text, ':', prov_id, ':', p_id, ':', COALESCE(rec.vendor_model_id, ''), ':', cap::text), 'sha256'), 'hex');

      INSERT INTO model_config_revisions(
        model_id, revision, provider_id, plugin_id, plugin_version,
        vendor_model_id, base_url, credential_id, credential_schema_version,
        capabilities, normalized_config, defaults, snapshot_digest, created_by, created_at
      ) VALUES (
        rec.id, 1, prov_id, p_id, '1.0.0',
        rec.vendor_model_id, rec.base_url, rec.provider_credential_id, cred_schema_ver,
        cap, norm, dflt, dig, rec.created_by, rec.created_at
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

-- Widen the role list for 局部框选修改: 'mask' carries the alpha PNG that marks
-- the region an edit may regenerate. ADD CONSTRAINT alone can never change an
-- already-installed check, so drop first — same pattern as the position
-- constraint relaxation below.
ALTER TABLE generation_job_inputs DROP CONSTRAINT IF EXISTS generation_job_inputs_role_check;
DO $$ BEGIN ALTER TABLE generation_job_inputs ADD CONSTRAINT generation_job_inputs_role_check CHECK(role IN ('prompt_image','reference_image','first_frame','last_frame','source_video','mask')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

-- An input can also *reference* an existing gallery image instead of an upload, so
-- reusing one's own earlier output never copies bytes. No upload row is created for
-- these, which is what keeps the upload TTL sweep and DELETE /generation-uploads
-- from ever reaching a gallery object.
ALTER TABLE generation_job_inputs ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES assets(id);
-- One-sided exclusion, not XOR: rows written before the upload_id backfill above have
-- both columns NULL, and ADD CONSTRAINT validates the whole table right now.
DO $$ BEGIN ALTER TABLE generation_job_inputs ADD CONSTRAINT generation_job_inputs_upload_or_asset_check CHECK(NOT (upload_id IS NOT NULL AND asset_id IS NOT NULL)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Deliberately non-unique: the same gallery image may feed any number of later jobs.
CREATE INDEX IF NOT EXISTS generation_job_inputs_asset_idx ON generation_job_inputs(asset_id) WHERE asset_id IS NOT NULL;

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
-- 10. Image plugin 1.1.0 cutover: new immutable latest revisions for active
-- openai-image / seedream-image models still pinned to 1.0.0.
-- Idempotent: models already carrying a 1.1.0 revision are skipped, and prior
-- revision rows are never rewritten — only new rows are inserted and
-- model_configs.latest_revision_id / plugin_version advances to them.
-- Shared legacy columns (adapter, sizes, vendor_model_id, ...) are retained.
-- Eligibility is conservative: only rows created from the known current image
-- presets advance, and only when both the mutable model columns AND the
-- pre-cutover latest snapshot agree (image kind, 1.0.0 plugin identity,
-- preset vendor ID, null-or-official base URL on each side independently,
-- and a null-or-official linked credential host). The new 1.1.0 revision
-- carries canonical capabilities/defaults/normalized_config built from the
-- validated columns — never copied latest JSON. Custom/manual configs,
-- unknown vendor IDs, and custom endpoints stay pinned to 1.0.0 where
-- permissive validation still accepts them.
UPDATE generation_jobs j
SET model_revision_id = m.latest_revision_id
FROM model_configs m
WHERE j.model_revision_id IS NULL
  AND j.model_id = m.id
  AND j.status IN ('queued', 'running', 'retry_wait')
  AND j.deleted_at IS NULL
  AND m.latest_revision_id IS NOT NULL;

INSERT INTO model_config_revisions(
  model_id, revision, provider_id, plugin_id, plugin_version,
  vendor_model_id, base_url, credential_id, credential_schema_version,
  capabilities, normalized_config, defaults, snapshot_digest, created_by, created_at
)
SELECT
  m.id,
  (SELECT COALESCE(MAX(revision), 0) + 1 FROM model_config_revisions WHERE model_id = m.id),
  COALESCE(latest.provider_id, m.provider_id),
  COALESCE(latest.plugin_id, m.plugin_id),
  '1.1.0',
  latest.vendor_model_id,
  latest.base_url,
  latest.credential_id,
  latest.credential_schema_version,
  jsonb_build_object(
    'modes', CASE WHEN COALESCE(m.max_input_images, 0) > 0 THEN
      jsonb_build_array('text_to_image', 'image_to_image')
    ELSE jsonb_build_array('text_to_image') END,
    'parameters', CASE WHEN COALESCE(m.quality_options, '[]'::jsonb) = '[]'::jsonb THEN
      jsonb_build_array(
        jsonb_build_object('type', 'enum', 'name', 'size', 'label', '尺寸', 'options', COALESCE(m.sizes, '[]'::jsonb)),
        jsonb_build_object('type', 'integer', 'name', 'count', 'label', '数量', 'min', 1, 'max', COALESCE(m.max_count, 1), 'defaultValue', 1))
    ELSE
      jsonb_build_array(
        jsonb_build_object('type', 'enum', 'name', 'size', 'label', '尺寸', 'options', COALESCE(m.sizes, '[]'::jsonb)),
        jsonb_build_object('type', 'enum', 'name', 'quality', 'label', '质量', 'options', COALESCE(m.quality_options, '[]'::jsonb)),
        jsonb_build_object('type', 'integer', 'name', 'count', 'label', '数量', 'min', 1, 'max', COALESCE(m.max_count, 1), 'defaultValue', 1))
    END,
    'inputSlots', CASE WHEN COALESCE(m.max_input_images, 0) > 0 THEN
      jsonb_build_array(jsonb_build_object('role', 'reference_image', 'required', false, 'minCount', 0, 'maxCount', m.max_input_images, 'allowedMediaKinds', jsonb_build_array('image')))
    ELSE '[]'::jsonb END,
    'maxCount', COALESCE(m.max_count, 1),
    'supportedMediaKinds', jsonb_build_array('image'),
    'mediaKind', 'image'),
  jsonb_strip_nulls(jsonb_build_object(
    'vendorModelId', m.vendor_model_id,
    'baseUrl', m.base_url,
    'concurrencyLimit', m.concurrency_limit,
    'watermark', m.watermark,
    'modelKind', m.model_kind)),
  '{}'::jsonb,
  encode(digest(concat(m.id::text, ':', COALESCE(latest.provider_id, m.provider_id, ''), ':', COALESCE(latest.plugin_id, m.plugin_id, ''), ':1.1.0:canonical-v1:', COALESCE(latest.snapshot_digest, '')), 'sha256'), 'hex'),
  m.created_by,
  now()
FROM model_configs m
JOIN model_config_revisions latest ON latest.id = m.latest_revision_id
LEFT JOIN provider_credentials cred ON cred.id = latest.credential_id AND cred.deleted_at IS NULL
WHERE m.deleted_at IS NULL
  AND m.plugin_id IN ('openai-image', 'seedream-image')
  AND m.plugin_version = '1.0.0'
  AND latest.credential_id IS NOT DISTINCT FROM m.provider_credential_id
  AND (
    (m.preset_id = 'openai-gpt-image-2' AND m.model_kind = 'image' AND m.vendor_model_id = 'gpt-image-2'
      AND latest.plugin_id = m.plugin_id AND latest.plugin_version = '1.0.0' AND latest.vendor_model_id = 'gpt-image-2'
      AND (latest.base_url IS NULL OR latest.base_url IN ('https://api.openai.com', 'https://api.openai.com/'))
      AND (latest.credential_id IS NULL OR (cred.id IS NOT NULL
        AND (cred.base_url IS NULL OR cred.base_url IN ('https://api.openai.com', 'https://api.openai.com/'))))
      AND COALESCE(m.max_count, 0) BETWEEN 1 AND 4 AND COALESCE(m.max_input_images, 0) BETWEEN 0 AND 4
      AND jsonb_typeof(COALESCE(m.sizes, '[]'::jsonb)) = 'array' AND COALESCE(m.sizes, '[]'::jsonb) <> '[]'::jsonb
      AND COALESCE(m.sizes, '[]'::jsonb) <@ '["1024x1024","1280x720","720x1280","1536x1024","1024x1536"]'::jsonb
      AND COALESCE(m.quality_options, '[]'::jsonb) <> '[]'::jsonb
      AND COALESCE(m.quality_options, '[]'::jsonb) <@ '["auto","low","medium","high"]'::jsonb
      AND (m.base_url IS NULL OR m.base_url IN ('https://api.openai.com', 'https://api.openai.com/')))
    OR (m.preset_id = 'seedream-4-0' AND m.model_kind = 'image' AND m.vendor_model_id = 'doubao-seedream-4-0-250828'
      AND latest.plugin_id = m.plugin_id AND latest.plugin_version = '1.0.0' AND latest.vendor_model_id = 'doubao-seedream-4-0-250828'
      AND (latest.credential_id IS NULL OR (cred.id IS NOT NULL
        AND (cred.base_url IS NULL OR cred.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/'))))
      AND (latest.base_url IS NULL OR latest.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/'))
      AND COALESCE(m.max_count, 0) BETWEEN 1 AND 4 AND COALESCE(m.max_input_images, 0) BETWEEN 0 AND 4
      AND jsonb_typeof(COALESCE(m.sizes, '[]'::jsonb)) = 'array' AND COALESCE(m.sizes, '[]'::jsonb) <> '[]'::jsonb
      AND COALESCE(m.sizes, '[]'::jsonb) <@ '["1024x1024","1152x864","864x1152","1280x720","720x1280","1248x832","832x1248","1512x648","2048x2048","2304x1728","1728x2304","2848x1600","1600x2848","2496x1664","1664x2496","3136x1344","4096x4096","4704x3520","3520x4704","5504x3040","3040x5504","4992x3328","3328x4992","6240x2656"]'::jsonb
      AND COALESCE(m.quality_options, '[]'::jsonb) = '[]'::jsonb
      AND (m.base_url IS NULL OR m.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/')))
    OR (m.preset_id = 'seedream-4-5' AND m.model_kind = 'image' AND m.vendor_model_id = 'doubao-seedream-4-5-251128'
      AND latest.plugin_id = m.plugin_id AND latest.plugin_version = '1.0.0' AND latest.vendor_model_id = 'doubao-seedream-4-5-251128'
      AND (latest.credential_id IS NULL OR (cred.id IS NOT NULL
        AND (cred.base_url IS NULL OR cred.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/'))))
      AND COALESCE(m.max_count, 0) BETWEEN 1 AND 4 AND COALESCE(m.max_input_images, 0) BETWEEN 0 AND 4
      AND (latest.base_url IS NULL OR latest.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/'))
      AND jsonb_typeof(COALESCE(m.sizes, '[]'::jsonb)) = 'array' AND COALESCE(m.sizes, '[]'::jsonb) <> '[]'::jsonb
      AND COALESCE(m.sizes, '[]'::jsonb) <@ '["2048x2048","2304x1728","1728x2304","2848x1600","1600x2848","2496x1664","1664x2496","3136x1344","4096x4096","4704x3520","3520x4704","5504x3040","3040x5504","4992x3328","3328x4992","6240x2656"]'::jsonb
      AND COALESCE(m.quality_options, '[]'::jsonb) = '[]'::jsonb
      AND (m.base_url IS NULL OR m.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/')))
  )
  AND NOT EXISTS (
    SELECT 1 FROM model_config_revisions r2
    WHERE r2.model_id = m.id AND r2.plugin_id = m.plugin_id AND r2.plugin_version = '1.1.0'
  );

UPDATE model_configs m
SET plugin_version = '1.1.0',
    latest_revision_id = r.id,
    updated_at = now()
FROM model_config_revisions r
LEFT JOIN provider_credentials cred ON cred.id = r.credential_id AND cred.deleted_at IS NULL
WHERE r.model_id = m.id
  AND r.plugin_id = m.plugin_id
  AND r.plugin_version = '1.1.0'
  AND r.id = (
    SELECT r2.id FROM model_config_revisions r2
    WHERE r2.model_id = m.id AND r2.plugin_id = m.plugin_id AND r2.plugin_version = '1.1.0'
    ORDER BY r2.revision DESC, r2.created_at DESC LIMIT 1
  )
  AND m.deleted_at IS NULL
  AND m.plugin_id IN ('openai-image', 'seedream-image')
  AND m.plugin_version = '1.0.0'
  AND r.credential_id IS NOT DISTINCT FROM m.provider_credential_id
  AND (
    (m.preset_id = 'openai-gpt-image-2' AND m.model_kind = 'image' AND m.vendor_model_id = 'gpt-image-2'
      AND r.vendor_model_id = 'gpt-image-2'
      AND (r.base_url IS NULL OR r.base_url IN ('https://api.openai.com', 'https://api.openai.com/'))
      AND COALESCE(m.max_count, 0) BETWEEN 1 AND 4 AND COALESCE(m.max_input_images, 0) BETWEEN 0 AND 4
      AND jsonb_typeof(COALESCE(m.sizes, '[]'::jsonb)) = 'array' AND COALESCE(m.sizes, '[]'::jsonb) <> '[]'::jsonb
      AND (r.credential_id IS NULL OR (cred.id IS NOT NULL
        AND (cred.base_url IS NULL OR cred.base_url IN ('https://api.openai.com', 'https://api.openai.com/'))))
      AND COALESCE(m.sizes, '[]'::jsonb) <@ '["1024x1024","1280x720","720x1280","1536x1024","1024x1536"]'::jsonb
      AND COALESCE(m.quality_options, '[]'::jsonb) <> '[]'::jsonb
      AND COALESCE(m.quality_options, '[]'::jsonb) <@ '["auto","low","medium","high"]'::jsonb
      AND (m.base_url IS NULL OR m.base_url IN ('https://api.openai.com', 'https://api.openai.com/')))
    OR (m.preset_id = 'seedream-4-0' AND m.model_kind = 'image' AND m.vendor_model_id = 'doubao-seedream-4-0-250828'
      AND r.vendor_model_id = 'doubao-seedream-4-0-250828'
      AND (r.base_url IS NULL OR r.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/'))
      AND COALESCE(m.max_count, 0) BETWEEN 1 AND 4 AND COALESCE(m.max_input_images, 0) BETWEEN 0 AND 4
      AND jsonb_typeof(COALESCE(m.sizes, '[]'::jsonb)) = 'array' AND COALESCE(m.sizes, '[]'::jsonb) <> '[]'::jsonb
      AND COALESCE(m.sizes, '[]'::jsonb) <@ '["1024x1024","1152x864","864x1152","1280x720","720x1280","1248x832","832x1248","1512x648","2048x2048","2304x1728","1728x2304","2848x1600","1600x2848","2496x1664","1664x2496","3136x1344","4096x4096","4704x3520","3520x4704","5504x3040","3040x5504","4992x3328","3328x4992","6240x2656"]'::jsonb
      AND (r.credential_id IS NULL OR (cred.id IS NOT NULL
        AND (cred.base_url IS NULL OR cred.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/'))))
      AND COALESCE(m.quality_options, '[]'::jsonb) = '[]'::jsonb
      AND (m.base_url IS NULL OR m.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/')))
    OR (m.preset_id = 'seedream-4-5' AND m.model_kind = 'image' AND m.vendor_model_id = 'doubao-seedream-4-5-251128'
      AND r.vendor_model_id = 'doubao-seedream-4-5-251128'
      AND (r.base_url IS NULL OR r.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/'))
      AND COALESCE(m.max_count, 0) BETWEEN 1 AND 4 AND COALESCE(m.max_input_images, 0) BETWEEN 0 AND 4
      AND jsonb_typeof(COALESCE(m.sizes, '[]'::jsonb)) = 'array' AND COALESCE(m.sizes, '[]'::jsonb) <> '[]'::jsonb
      AND COALESCE(m.sizes, '[]'::jsonb) <@ '["2048x2048","2304x1728","1728x2304","2848x1600","1600x2848","2496x1664","1664x2496","3136x1344","4096x4096","4704x3520","3520x4704","5504x3040","3040x5504","4992x3328","3328x4992","6240x2656"]'::jsonb
      AND (r.credential_id IS NULL OR (cred.id IS NOT NULL
        AND (cred.base_url IS NULL OR cred.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/'))))
      AND COALESCE(m.quality_options, '[]'::jsonb) = '[]'::jsonb
      AND (m.base_url IS NULL OR m.base_url IN ('https://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com/')))
  );


-- 10b. Plugin-declared media capabilities: new immutable revisions carrying the
-- parameter contract the provider plugin itself authored, instead of the
-- size/quality lists the host used to derive from flat model_configs columns.
--
-- Purely additive and idempotent. Prior revision rows are never updated and
-- generation_jobs / generation_outputs / assets are not touched at all, so a job
-- keeps rendering the parameters it was actually created with even where those
-- values are no longer offered. Only new revisions are inserted and
-- model_configs.latest_revision_id advances to them.
--
-- Re-running converges: a model is skipped once its newest revision already
-- carries the same declared descriptor set, compared on descriptor content
-- rather than on a digest string (which also moves when unrelated inputs move).
--
-- The descriptor JSON below is embedded because SQL cannot read a TypeScript
-- manifest — the same unavoidable copy section 10 already makes for sizes. It is
-- generated from the live plugin registry, and
-- tests/integration/capabilities-backfill.test.ts asserts it still equals what the
-- plugins publish, so a drifted copy fails CI instead of quietly serving a stale
-- contract.
WITH declared(plugin_id, plugin_version, vendor_model_id, capabilities, defaults) AS (
  VALUES
    ('openai-image', '1.1.0', 'gpt-image-2.5-sunburst',
     '{"modes":["text_to_image","image_to_image"],"parameters":[{"type":"image-size","name":"size","label":"尺寸","description":"可选择预设尺寸，或按下方限制自定义宽高","presets":[{"value":"auto","label":"自动"},{"value":"1024x1024","width":1024,"height":1024,"label":"1:1 · 1024 × 1024"},{"value":"1536x1024","width":1536,"height":1024,"label":"3:2 · 1536 × 1024"},{"value":"1024x1536","width":1024,"height":1536,"label":"2:3 · 1024 × 1536"},{"value":"2048x2048","width":2048,"height":2048,"label":"1:1 · 2048 × 2048","experimental":true,"description":"高分辨率输出可能具有更高延迟，且部分超高分辨率能力仍属于实验性支持。"},{"value":"2048x1152","width":2048,"height":1152,"label":"16:9 · 2048 × 1152"},{"value":"3840x2160","width":3840,"height":2160,"label":"16:9 · 3840 × 2160","experimental":true,"description":"高分辨率输出可能具有更高延迟，且部分超高分辨率能力仍属于实验性支持。"},{"value":"2160x3840","width":2160,"height":3840,"label":"9:16 · 2160 × 3840","experimental":true,"description":"高分辨率输出可能具有更高延迟，且部分超高分辨率能力仍属于实验性支持。"}],"allowCustom":true,"constraints":{"maxWidth":3840,"maxHeight":3840,"widthMultipleOf":16,"heightMultipleOf":16,"minPixels":655360,"maxPixels":8294400,"maxAspectRatio":3},"defaultValue":"auto","ui":{"control":"size-picker"}},{"type":"enum","name":"quality","label":"质量","options":[{"value":"auto","label":"自动","description":"由模型结合尺寸与提示词自行选择档位"},{"value":"low","label":"Low","description":"最快，细节较少"},{"value":"medium","label":"Medium"},{"value":"high","label":"High","description":"细节更完整，耗时更长"},{"value":"xhigh","label":"XHigh","description":"高于 High 的档位"},{"value":"max","label":"Max","description":"最高质量档位，延迟与消耗最大"}],"defaultValue":"auto"},{"type":"enum","name":"background","label":"背景","options":[{"value":"auto","label":"自动"},{"value":"opaque","label":"不透明"},{"value":"transparent","label":"透明","description":"输出带 alpha 通道，只能配合 png 或 webp"}],"defaultValue":"auto"},{"type":"enum","name":"output_format","label":"输出格式","options":[{"value":"png","label":"PNG","description":"支持 alpha 通道"},{"value":"jpeg","label":"JPEG"},{"value":"webp","label":"WebP","description":"支持 alpha 通道"}],"defaultValue":"png"},{"type":"integer","name":"output_compression","label":"输出压缩","description":"lossy 格式的压缩质量（0 最压缩，100 最保真）","min":0,"max":100,"defaultValue":100,"dependsOn":{"parameter":"output_format","values":["jpeg","webp"]},"ui":{"control":"slider","advanced":true}},{"type":"integer","name":"count","label":"数量","description":"一次请求生成的图片张数","min":1,"max":4,"defaultValue":1}],"inputSlots":[{"role":"reference_image","required":false,"minCount":0,"maxCount":4,"allowedMediaKinds":["image"],"label":"参考图","description":"作为编辑基础或风格参考的图片"},{"role":"mask","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"选区遮罩","description":"带 alpha 通道的 PNG，限定可重绘的区域"}],"maxCount":4,"supportedMediaKinds":["image"],"flags":{"textToImage":true,"imageToImage":true,"imageEdit":true,"mask":true,"inpainting":true,"transparentBackground":true},"crossFieldConstraints":[{"type":"forbidden","parameter":"background","whenValueEquals":"transparent","targetParameter":"output_format","targetValues":["jpeg"],"message":"background=transparent 需要 alpha 通道，output_format 只能是 png 或 webp"}],"declaredBy":"plugin-manifest"}'::jsonb,
     '{"size":"auto","quality":"auto","background":"auto","output_format":"png","count":1}'::jsonb),
    ('openai-image', '1.1.0', 'gpt-image-2.5-flare',
     '{"modes":["text_to_image","image_to_image"],"parameters":[{"type":"image-size","name":"size","label":"尺寸","description":"可选择预设尺寸，或按下方限制自定义宽高","presets":[{"value":"auto","label":"自动"},{"value":"1024x1024","width":1024,"height":1024,"label":"1:1 · 1024 × 1024"},{"value":"1536x1024","width":1536,"height":1024,"label":"3:2 · 1536 × 1024"},{"value":"1024x1536","width":1024,"height":1536,"label":"2:3 · 1024 × 1536"},{"value":"2048x2048","width":2048,"height":2048,"label":"1:1 · 2048 × 2048","experimental":true,"description":"高分辨率输出可能具有更高延迟，且部分超高分辨率能力仍属于实验性支持。"},{"value":"2048x1152","width":2048,"height":1152,"label":"16:9 · 2048 × 1152"},{"value":"3840x2160","width":3840,"height":2160,"label":"16:9 · 3840 × 2160","experimental":true,"description":"高分辨率输出可能具有更高延迟，且部分超高分辨率能力仍属于实验性支持。"},{"value":"2160x3840","width":2160,"height":3840,"label":"9:16 · 2160 × 3840","experimental":true,"description":"高分辨率输出可能具有更高延迟，且部分超高分辨率能力仍属于实验性支持。"}],"allowCustom":true,"constraints":{"maxWidth":3840,"maxHeight":3840,"widthMultipleOf":16,"heightMultipleOf":16,"minPixels":655360,"maxPixels":8294400,"maxAspectRatio":3},"defaultValue":"auto","ui":{"control":"size-picker"}},{"type":"enum","name":"quality","label":"质量","options":[{"value":"auto","label":"自动","description":"由模型结合尺寸与提示词自行选择档位"},{"value":"low","label":"Low","description":"最快，细节较少"},{"value":"medium","label":"Medium"},{"value":"high","label":"High","description":"细节更完整，耗时更长"},{"value":"xhigh","label":"XHigh","description":"高于 High 的档位"},{"value":"max","label":"Max","description":"最高质量档位，延迟与消耗最大"}],"defaultValue":"auto"},{"type":"enum","name":"background","label":"背景","options":[{"value":"auto","label":"自动"},{"value":"opaque","label":"不透明"},{"value":"transparent","label":"透明","description":"输出带 alpha 通道，只能配合 png 或 webp"}],"defaultValue":"auto"},{"type":"enum","name":"output_format","label":"输出格式","options":[{"value":"png","label":"PNG","description":"支持 alpha 通道"},{"value":"jpeg","label":"JPEG"},{"value":"webp","label":"WebP","description":"支持 alpha 通道"}],"defaultValue":"png"},{"type":"integer","name":"output_compression","label":"输出压缩","description":"lossy 格式的压缩质量（0 最压缩，100 最保真）","min":0,"max":100,"defaultValue":100,"dependsOn":{"parameter":"output_format","values":["jpeg","webp"]},"ui":{"control":"slider","advanced":true}},{"type":"integer","name":"count","label":"数量","description":"一次请求生成的图片张数","min":1,"max":4,"defaultValue":1}],"inputSlots":[{"role":"reference_image","required":false,"minCount":0,"maxCount":4,"allowedMediaKinds":["image"],"label":"参考图","description":"作为编辑基础或风格参考的图片"},{"role":"mask","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"选区遮罩","description":"带 alpha 通道的 PNG，限定可重绘的区域"}],"maxCount":4,"supportedMediaKinds":["image"],"flags":{"textToImage":true,"imageToImage":true,"imageEdit":true,"mask":true,"inpainting":true,"transparentBackground":true},"crossFieldConstraints":[{"type":"forbidden","parameter":"background","whenValueEquals":"transparent","targetParameter":"output_format","targetValues":["jpeg"],"message":"background=transparent 需要 alpha 通道，output_format 只能是 png 或 webp"}],"declaredBy":"plugin-manifest"}'::jsonb,
     '{"size":"auto","quality":"auto","background":"auto","output_format":"png","count":1}'::jsonb),
    ('openai-image', '1.1.0', 'gpt-image-2',
     '{"modes":["text_to_image","image_to_image"],"parameters":[{"type":"image-size","name":"size","label":"尺寸","description":"可选择预设尺寸，或按下方限制自定义宽高","presets":[{"value":"auto","label":"自动"},{"value":"1024x1024","width":1024,"height":1024,"label":"1:1 · 1024 × 1024"},{"value":"1280x720","width":1280,"height":720,"label":"16:9 · 1280 × 720"},{"value":"720x1280","width":720,"height":1280,"label":"9:16 · 720 × 1280"},{"value":"1536x1024","width":1536,"height":1024,"label":"3:2 · 1536 × 1024"},{"value":"1024x1536","width":1024,"height":1536,"label":"2:3 · 1024 × 1536"},{"value":"2048x2048","width":2048,"height":2048,"label":"1:1 · 2048 × 2048","experimental":true,"description":"高分辨率输出可能具有更高延迟，且部分超高分辨率能力仍属于实验性支持。"},{"value":"2048x1152","width":2048,"height":1152,"label":"16:9 · 2048 × 1152"},{"value":"3840x2160","width":3840,"height":2160,"label":"16:9 · 3840 × 2160","experimental":true,"description":"高分辨率输出可能具有更高延迟，且部分超高分辨率能力仍属于实验性支持。"},{"value":"2160x3840","width":2160,"height":3840,"label":"9:16 · 2160 × 3840","experimental":true,"description":"高分辨率输出可能具有更高延迟，且部分超高分辨率能力仍属于实验性支持。"}],"allowCustom":true,"constraints":{"maxWidth":3840,"maxHeight":3840,"widthMultipleOf":16,"heightMultipleOf":16,"minPixels":655360,"maxPixels":8294400,"maxAspectRatio":3},"defaultValue":"auto","ui":{"control":"size-picker"}},{"type":"enum","name":"quality","label":"质量","options":[{"value":"auto","label":"自动","description":"由模型结合尺寸与提示词自行选择档位"},{"value":"low","label":"Low","description":"最快，细节较少"},{"value":"medium","label":"Medium"},{"value":"high","label":"High","description":"细节更完整，耗时更长"}],"defaultValue":"auto"},{"type":"enum","name":"background","label":"背景","options":[{"value":"auto","label":"自动"},{"value":"opaque","label":"不透明"},{"value":"transparent","label":"透明","description":"输出带 alpha 通道，只能配合 png 或 webp"}],"defaultValue":"auto"},{"type":"enum","name":"output_format","label":"输出格式","options":[{"value":"png","label":"PNG","description":"支持 alpha 通道"},{"value":"jpeg","label":"JPEG"},{"value":"webp","label":"WebP","description":"支持 alpha 通道"}],"defaultValue":"png"},{"type":"integer","name":"output_compression","label":"输出压缩","description":"lossy 格式的压缩质量（0 最压缩，100 最保真）","min":0,"max":100,"defaultValue":100,"dependsOn":{"parameter":"output_format","values":["jpeg","webp"]},"ui":{"control":"slider","advanced":true}},{"type":"integer","name":"count","label":"数量","description":"一次请求生成的图片张数","min":1,"max":4,"defaultValue":1}],"inputSlots":[{"role":"reference_image","required":false,"minCount":0,"maxCount":4,"allowedMediaKinds":["image"],"label":"参考图","description":"作为编辑基础或风格参考的图片"},{"role":"mask","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"选区遮罩","description":"带 alpha 通道的 PNG，限定可重绘的区域"}],"maxCount":4,"supportedMediaKinds":["image"],"flags":{"textToImage":true,"imageToImage":true,"imageEdit":true,"mask":true,"inpainting":true,"transparentBackground":true},"crossFieldConstraints":[{"type":"forbidden","parameter":"background","whenValueEquals":"transparent","targetParameter":"output_format","targetValues":["jpeg"],"message":"background=transparent 需要 alpha 通道，output_format 只能是 png 或 webp"}],"declaredBy":"plugin-manifest"}'::jsonb,
     '{"size":"auto","quality":"auto","background":"auto","output_format":"png","count":1}'::jsonb),
    ('openai-image', '1.1.0', 'gpt-image-1.5',
     '{"modes":["text_to_image","image_to_image"],"parameters":[{"type":"image-size","name":"size","label":"尺寸","description":"该模型仅支持以下固定尺寸","presets":[{"value":"auto","label":"自动"},{"value":"1024x1024","width":1024,"height":1024,"label":"1:1 · 1024 × 1024"},{"value":"1024x1536","width":1024,"height":1536,"label":"2:3 · 1024 × 1536"},{"value":"1536x1024","width":1536,"height":1024,"label":"3:2 · 1536 × 1024"}],"defaultValue":"auto","ui":{"control":"size-picker"}},{"type":"enum","name":"quality","label":"质量","options":[{"value":"auto","label":"自动","description":"由模型结合尺寸与提示词自行选择档位"},{"value":"low","label":"Low","description":"最快，细节较少"},{"value":"medium","label":"Medium"},{"value":"high","label":"High","description":"细节更完整，耗时更长"}],"defaultValue":"auto"},{"type":"enum","name":"input_fidelity","label":"输入保真度","description":"编辑时保留输入图片细节的程度","options":[{"value":"low","label":"较低"},{"value":"high","label":"较高"}],"defaultValue":"high"},{"type":"integer","name":"count","label":"数量","description":"一次请求生成的图片张数","min":1,"max":4,"defaultValue":1}],"inputSlots":[{"role":"reference_image","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"参考图","description":"作为编辑基础或风格参考的图片"}],"maxCount":4,"supportedMediaKinds":["image"],"flags":{"textToImage":true,"imageToImage":true,"imageEdit":true},"declaredBy":"plugin-manifest"}'::jsonb,
     '{"size":"auto","quality":"auto","input_fidelity":"high","count":1}'::jsonb),
    ('openai-image', '1.1.0', 'dall-e-3',
     '{"modes":["text_to_image"],"parameters":[{"type":"image-size","name":"size","label":"尺寸","description":"该模型仅支持以下固定尺寸","presets":[{"value":"1024x1024","width":1024,"height":1024,"label":"1:1 · 1024 × 1024"},{"value":"1792x1024","width":1792,"height":1024,"label":"7:4 · 1792 × 1024"},{"value":"1024x1792","width":1024,"height":1792,"label":"4:7 · 1024 × 1792"}],"defaultValue":"1024x1024","ui":{"control":"size-picker"}},{"type":"enum","name":"quality","label":"质量","options":[{"value":"standard","label":"Standard"},{"value":"hd","label":"HD"}],"defaultValue":"standard"},{"type":"integer","name":"count","label":"数量","description":"一次请求生成的图片张数","min":1,"max":1,"defaultValue":1}],"inputSlots":[],"maxCount":1,"supportedMediaKinds":["image"],"flags":{"textToImage":true,"imageToImage":false,"imageEdit":false},"declaredBy":"plugin-manifest"}'::jsonb,
     '{"size":"1024x1024","quality":"standard","count":1}'::jsonb),
    ('seedream-image', '1.1.0', 'doubao-seedream-4-0-250828',
     '{"modes":["text_to_image","image_to_image"],"parameters":[{"type":"image-size","name":"size","label":"尺寸","presets":[{"value":"1024x1024","width":1024,"height":1024,"label":"1:1 · 1024 × 1024"},{"value":"1152x864","width":1152,"height":864,"label":"4:3 · 1152 × 864"},{"value":"864x1152","width":864,"height":1152,"label":"3:4 · 864 × 1152"},{"value":"1280x720","width":1280,"height":720,"label":"16:9 · 1280 × 720"},{"value":"720x1280","width":720,"height":1280,"label":"9:16 · 720 × 1280"},{"value":"1248x832","width":1248,"height":832,"label":"3:2 · 1248 × 832"},{"value":"832x1248","width":832,"height":1248,"label":"2:3 · 832 × 1248"},{"value":"1512x648","width":1512,"height":648,"label":"7:3 · 1512 × 648"},{"value":"2048x2048","width":2048,"height":2048,"label":"1:1 · 2048 × 2048"},{"value":"2304x1728","width":2304,"height":1728,"label":"4:3 · 2304 × 1728"},{"value":"1728x2304","width":1728,"height":2304,"label":"3:4 · 1728 × 2304"},{"value":"2848x1600","width":2848,"height":1600,"label":"89:50 · 2848 × 1600"},{"value":"1600x2848","width":1600,"height":2848,"label":"50:89 · 1600 × 2848"},{"value":"2496x1664","width":2496,"height":1664,"label":"3:2 · 2496 × 1664"},{"value":"1664x2496","width":1664,"height":2496,"label":"2:3 · 1664 × 2496"},{"value":"3136x1344","width":3136,"height":1344,"label":"7:3 · 3136 × 1344"},{"value":"4096x4096","width":4096,"height":4096,"label":"1:1 · 4096 × 4096"},{"value":"4704x3520","width":4704,"height":3520,"label":"147:110 · 4704 × 3520"},{"value":"3520x4704","width":3520,"height":4704,"label":"110:147 · 3520 × 4704"},{"value":"5504x3040","width":5504,"height":3040,"label":"172:95 · 5504 × 3040"},{"value":"3040x5504","width":3040,"height":5504,"label":"95:172 · 3040 × 5504"},{"value":"4992x3328","width":4992,"height":3328,"label":"3:2 · 4992 × 3328"},{"value":"3328x4992","width":3328,"height":4992,"label":"2:3 · 3328 × 4992"},{"value":"6240x2656","width":6240,"height":2656,"label":"195:83 · 6240 × 2656"}],"allowCustom":true,"constraints":{"maxPixels":16777216,"maxAspectRatio":16,"minPixels":921600},"defaultValue":"2048x2048","ui":{"control":"size-picker"}},{"type":"integer","name":"count","label":"数量","min":1,"max":4,"defaultValue":1},{"type":"boolean","name":"watermark","label":"水印","defaultValue":false}],"inputSlots":[{"role":"reference_image","required":false,"minCount":0,"maxCount":4,"allowedMediaKinds":["image"],"label":"参考图"}],"maxCount":4,"supportedMediaKinds":["image"],"flags":{"textToImage":true,"imageToImage":true,"imageEdit":true},"declaredBy":"plugin-manifest"}'::jsonb,
     '{"size":"2048x2048","count":1,"watermark":false}'::jsonb),
    ('seedream-image', '1.1.0', 'doubao-seedream-4-5-251128',
     '{"modes":["text_to_image","image_to_image"],"parameters":[{"type":"image-size","name":"size","label":"尺寸","presets":[{"value":"2048x2048","width":2048,"height":2048,"label":"1:1 · 2048 × 2048"},{"value":"2304x1728","width":2304,"height":1728,"label":"4:3 · 2304 × 1728"},{"value":"1728x2304","width":1728,"height":2304,"label":"3:4 · 1728 × 2304"},{"value":"2848x1600","width":2848,"height":1600,"label":"89:50 · 2848 × 1600"},{"value":"1600x2848","width":1600,"height":2848,"label":"50:89 · 1600 × 2848"},{"value":"2496x1664","width":2496,"height":1664,"label":"3:2 · 2496 × 1664"},{"value":"1664x2496","width":1664,"height":2496,"label":"2:3 · 1664 × 2496"},{"value":"3136x1344","width":3136,"height":1344,"label":"7:3 · 3136 × 1344"},{"value":"4096x4096","width":4096,"height":4096,"label":"1:1 · 4096 × 4096"},{"value":"4704x3520","width":4704,"height":3520,"label":"147:110 · 4704 × 3520"},{"value":"3520x4704","width":3520,"height":4704,"label":"110:147 · 3520 × 4704"},{"value":"5504x3040","width":5504,"height":3040,"label":"172:95 · 5504 × 3040"},{"value":"3040x5504","width":3040,"height":5504,"label":"95:172 · 3040 × 5504"},{"value":"4992x3328","width":4992,"height":3328,"label":"3:2 · 4992 × 3328"},{"value":"3328x4992","width":3328,"height":4992,"label":"2:3 · 3328 × 4992"},{"value":"6240x2656","width":6240,"height":2656,"label":"195:83 · 6240 × 2656"}],"allowCustom":true,"constraints":{"maxPixels":16777216,"maxAspectRatio":16,"minPixels":3686400},"defaultValue":"2048x2048","ui":{"control":"size-picker"}},{"type":"integer","name":"count","label":"数量","min":1,"max":4,"defaultValue":1},{"type":"boolean","name":"watermark","label":"水印","defaultValue":false}],"inputSlots":[{"role":"reference_image","required":false,"minCount":0,"maxCount":4,"allowedMediaKinds":["image"],"label":"参考图"}],"maxCount":4,"supportedMediaKinds":["image"],"flags":{"textToImage":true,"imageToImage":true,"imageEdit":true},"declaredBy":"plugin-manifest"}'::jsonb,
     '{"size":"2048x2048","count":1,"watermark":false}'::jsonb),
    ('seedance-video', '1.0.0', 'doubao-seedance-2-0-fast-260128',
     '{"modes":["text_to_video","image_to_video"],"parameters":[{"type":"integer","name":"durationSeconds","label":"时长（秒）","min":1,"max":30,"defaultValue":5,"ui":{"control":"slider","unit":"秒","order":1}},{"type":"enum","name":"aspectRatio","label":"宽高比","options":["16:9","9:16","1:1","4:3","3:4","21:9"],"defaultValue":"16:9","ui":{"control":"select","order":2}},{"type":"enum","name":"resolution","label":"分辨率","options":["720p","1080p"],"defaultValue":"720p","ui":{"control":"segmented","order":3}},{"type":"boolean","name":"audio","label":"生成音频","defaultValue":true,"ui":{"control":"switch","order":4}},{"type":"integer","name":"count","label":"生成数量","min":1,"max":4,"defaultValue":1,"ui":{"control":"number","order":5}},{"type":"integer","name":"seed","label":"随机种子","min":0,"max":2147483647,"ui":{"control":"number","advanced":true,"order":6}},{"type":"boolean","name":"watermark","label":"水印","defaultValue":false,"ui":{"control":"switch","advanced":true,"order":7}},{"type":"boolean","name":"camera_fixed","label":"镜头固定","ui":{"control":"switch","advanced":true,"order":8}},{"type":"integer","name":"frames","label":"总帧数","min":1,"max":10000,"ui":{"control":"number","advanced":true,"order":9}}],"inputSlots":[{"role":"first_frame","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"首帧"},{"role":"last_frame","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"尾帧"},{"role":"reference_image","required":false,"minCount":0,"maxCount":4,"allowedMediaKinds":["image"],"label":"参考图"},{"role":"mask","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"蒙版"}],"maxCount":4,"supportedMediaKinds":["video"],"declaredBy":"plugin-manifest"}'::jsonb,
     '{"durationSeconds":5,"aspectRatio":"16:9","resolution":"720p","audio":true,"count":1}'::jsonb),
    ('seedance-video', '1.0.0', 'dreamina-seedance-2-0-fast-260128',
     '{"modes":["text_to_video","image_to_video"],"parameters":[{"type":"integer","name":"durationSeconds","label":"时长（秒）","min":1,"max":30,"defaultValue":5,"ui":{"control":"slider","unit":"秒","order":1}},{"type":"enum","name":"aspectRatio","label":"宽高比","options":["16:9","9:16","1:1","4:3","3:4","21:9"],"defaultValue":"16:9","ui":{"control":"select","order":2}},{"type":"enum","name":"resolution","label":"分辨率","options":["720p","1080p"],"defaultValue":"720p","ui":{"control":"segmented","order":3}},{"type":"boolean","name":"audio","label":"生成音频","defaultValue":true,"ui":{"control":"switch","order":4}},{"type":"integer","name":"count","label":"生成数量","min":1,"max":4,"defaultValue":1,"ui":{"control":"number","order":5}},{"type":"integer","name":"seed","label":"随机种子","min":0,"max":2147483647,"ui":{"control":"number","advanced":true,"order":6}},{"type":"boolean","name":"watermark","label":"水印","defaultValue":false,"ui":{"control":"switch","advanced":true,"order":7}},{"type":"boolean","name":"camera_fixed","label":"镜头固定","ui":{"control":"switch","advanced":true,"order":8}},{"type":"integer","name":"frames","label":"总帧数","min":1,"max":10000,"ui":{"control":"number","advanced":true,"order":9}}],"inputSlots":[{"role":"first_frame","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"首帧"},{"role":"last_frame","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"尾帧"},{"role":"reference_image","required":false,"minCount":0,"maxCount":4,"allowedMediaKinds":["image"],"label":"参考图"},{"role":"mask","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"蒙版"}],"maxCount":4,"supportedMediaKinds":["video"],"declaredBy":"plugin-manifest"}'::jsonb,
     '{"durationSeconds":5,"aspectRatio":"16:9","resolution":"720p","audio":true,"count":1}'::jsonb),
    ('veo-video', '1.0.0', 'veo-3.1-generate-001',
     '{"modes":["text_to_video","image_to_video"],"parameters":[{"type":"enum","name":"durationSeconds","label":"时长（秒）","options":["4","6","8"],"defaultValue":"8","ui":{"control":"segmented","unit":"秒","order":1}},{"type":"enum","name":"aspectRatio","label":"宽高比","options":["16:9","9:16"],"defaultValue":"16:9","ui":{"control":"segmented","order":2}},{"type":"enum","name":"resolution","label":"分辨率","options":["720p","1080p","4k"],"defaultValue":"1080p","ui":{"control":"segmented","order":3}},{"type":"boolean","name":"audio","label":"生成音频","defaultValue":true,"ui":{"control":"switch","order":4}},{"type":"integer","name":"count","label":"生成数量","min":1,"max":4,"defaultValue":1,"ui":{"control":"number","order":5}}],"inputSlots":[{"role":"first_frame","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"首帧"},{"role":"last_frame","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"尾帧"},{"role":"reference_image","required":false,"minCount":0,"maxCount":4,"allowedMediaKinds":["image"],"label":"参考图"}],"maxCount":4,"supportedMediaKinds":["video"],"crossFieldConstraints":[{"type":"forbidden","parameter":"resolution","whenValueEquals":"1080p","targetParameter":"durationSeconds","targetValues":["4","6"],"message":"分辨率 1080p 需要时长 8 秒"},{"type":"forbidden","parameter":"resolution","whenValueEquals":"4k","targetParameter":"durationSeconds","targetValues":["4","6"],"message":"分辨率 4k 需要时长 8 秒"}],"declaredBy":"plugin-manifest"}'::jsonb,
     '{"durationSeconds":"8","aspectRatio":"16:9","resolution":"1080p","audio":true,"count":1}'::jsonb),
    ('veo-video', '1.0.0', 'veo-3.1-fast-generate-001',
     '{"modes":["text_to_video","image_to_video"],"parameters":[{"type":"enum","name":"durationSeconds","label":"时长（秒）","options":["4","6","8"],"defaultValue":"8","ui":{"control":"segmented","unit":"秒","order":1}},{"type":"enum","name":"aspectRatio","label":"宽高比","options":["16:9","9:16"],"defaultValue":"16:9","ui":{"control":"segmented","order":2}},{"type":"enum","name":"resolution","label":"分辨率","options":["720p"],"defaultValue":"720p","ui":{"control":"segmented","order":3}},{"type":"boolean","name":"audio","label":"生成音频","defaultValue":true,"ui":{"control":"switch","order":4}},{"type":"integer","name":"count","label":"生成数量","min":1,"max":4,"defaultValue":1,"ui":{"control":"number","order":5}}],"inputSlots":[{"role":"first_frame","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"首帧"},{"role":"last_frame","required":false,"minCount":0,"maxCount":1,"allowedMediaKinds":["image"],"label":"尾帧"},{"role":"reference_image","required":false,"minCount":0,"maxCount":4,"allowedMediaKinds":["image"],"label":"参考图"}],"maxCount":4,"supportedMediaKinds":["video"],"crossFieldConstraints":[{"type":"forbidden","parameter":"resolution","whenValueEquals":"1080p","targetParameter":"durationSeconds","targetValues":["4","6"],"message":"分辨率 1080p 需要时长 8 秒"},{"type":"forbidden","parameter":"resolution","whenValueEquals":"4k","targetParameter":"durationSeconds","targetValues":["4","6"],"message":"分辨率 4k 需要时长 8 秒"}],"declaredBy":"plugin-manifest"}'::jsonb,
     '{"durationSeconds":"8","aspectRatio":"16:9","resolution":"720p","audio":true,"count":1}'::jsonb)
),
candidate AS (
  SELECT m.id AS model_id,
         d.capabilities,
         d.defaults,
         COALESCE(latest.provider_id, m.provider_id) AS provider_id,
         COALESCE(latest.plugin_id, m.plugin_id) AS plugin_id,
         COALESCE(latest.plugin_version, m.plugin_version, '1.0.0') AS plugin_version,
         COALESCE(latest.vendor_model_id, m.vendor_model_id) AS vendor_model_id,
         COALESCE(latest.base_url, m.base_url) AS base_url,
         latest.credential_id,
         latest.credential_schema_version,
         COALESCE(latest.normalized_config, '{}'::jsonb) AS normalized_config,
         m.created_by
  -- The current revision is resolved before the declared join, because the
  -- a model's plugin identity lives on that snapshot, not on the
  -- mutable model_configs row.
  FROM model_configs m
  LEFT JOIN model_config_revisions latest ON latest.id = m.latest_revision_id
  JOIN declared d
    ON d.vendor_model_id = COALESCE(latest.vendor_model_id, m.vendor_model_id)
   AND d.plugin_id = COALESCE(latest.plugin_id, m.plugin_id)
   -- The version has to match too. Legacy 1.0.0 image manifests deliberately
   -- publish no contract so already-pinned revisions stay permissive, so applying
   -- a 1.1.0 declaration to a 1.0.0 model would tighten a rule underneath a
   -- configuration that was valid when it was saved.
   AND d.plugin_version = COALESCE(latest.plugin_version, m.plugin_version, '1.0.0')
  WHERE m.deleted_at IS NULL
),
to_insert AS (
  SELECT c.*,
         (SELECT COALESCE(MAX(r0.revision), 0) + 1
            FROM model_config_revisions r0 WHERE r0.model_id = c.model_id) AS revision
  FROM candidate c
  WHERE NOT EXISTS (
    SELECT 1 FROM model_config_revisions r
    WHERE r.model_id = c.model_id
      AND r.capabilities->>'declaredBy' = 'plugin-manifest'
      AND r.capabilities->'parameters'::text = c.capabilities->'parameters'::text
  )
)
INSERT INTO model_config_revisions(
  model_id, revision, provider_id, plugin_id, plugin_version, vendor_model_id,
  base_url, credential_id, credential_schema_version, capabilities, normalized_config,
  defaults, snapshot_digest, created_by, created_at)
SELECT model_id, revision, provider_id, plugin_id, plugin_version, vendor_model_id,
       base_url, credential_id, credential_schema_version, capabilities, normalized_config,
       defaults,
       encode(digest(concat(model_id::text, ':', revision::text, ':plugin-manifest:', capabilities::text), 'sha256'), 'hex'),
       created_by, now()
FROM to_insert
WHERE plugin_id IS NOT NULL AND provider_id IS NOT NULL;

-- Advance the pointer, and only onto a manifest-declared revision that really is
-- the newest one for that model.
UPDATE model_configs m
SET latest_revision_id = adv.id, updated_at = now()
FROM model_config_revisions adv
WHERE adv.model_id = m.id
  AND adv.capabilities->>'declaredBy' = 'plugin-manifest'
  AND adv.revision = (SELECT MAX(r2.revision) FROM model_config_revisions r2 WHERE r2.model_id = m.id)
  AND m.latest_revision_id IS DISTINCT FROM adv.id
  AND m.deleted_at IS NULL;

-- 11. Resumable, secure onboarding foundation.
-- Explicit completion state replaces admin-count completion checks: status only
-- ever transitions pending -> complete, so completed deployments stay complete
-- even if admins are later deleted. Secrets are stored only as opaque
-- ciphertext plus fingerprint/key-id columns; no plaintext secret columns exist.
CREATE TABLE IF NOT EXISTS onboarding_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete')),
  bootstrap_status text NOT NULL DEFAULT 'pending' CHECK(bootstrap_status IN ('pending','complete')),
  site_status text NOT NULL DEFAULT 'pending' CHECK(site_status IN ('pending','complete')),
  smtp_status text NOT NULL DEFAULT 'pending' CHECK(smtp_status IN ('pending','complete')),
  admin_status text NOT NULL DEFAULT 'pending' CHECK(admin_status IN ('pending','complete')),
  storage_status text NOT NULL DEFAULT 'pending' CHECK(storage_status IN ('pending','complete')),
  providers_status text NOT NULL DEFAULT 'pending' CHECK(providers_status IN ('pending','complete')),
  models_status text NOT NULL DEFAULT 'pending' CHECK(models_status IN ('pending','complete')),
  oauth_status text NOT NULL DEFAULT 'pending' CHECK(oauth_status IN ('pending','complete')),
  templates_status text NOT NULL DEFAULT 'pending' CHECK(templates_status IN ('pending','complete')),
  runtime_status text NOT NULL DEFAULT 'pending' CHECK(runtime_status IN ('pending','complete')),
  config_revision integer NOT NULL DEFAULT 0 CHECK(config_revision >= 0),
  completed_at timestamptz,
  claim_token_hash text,
  claim_expires_at timestamptz,
  claim_attempts integer NOT NULL DEFAULT 0 CHECK(claim_attempts >= 0),
  claim_consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  CHECK(status <> 'complete' OR completed_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS app_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  site_name text,
  site_url text,
  revision integer NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS smtp_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  host text,
  port integer CHECK(port IS NULL OR (port >= 1 AND port <= 65535)),
  tls_mode text NOT NULL DEFAULT 'none' CHECK(tls_mode IN ('none','starttls','implicit_tls')),
  username text,
  password_encrypted text,
  password_fingerprint text,
  encryption_key_id text,
  from_address text,
  from_name text,
  status text NOT NULL DEFAULT 'not_configured' CHECK(status IN ('not_configured','configured','verified','error')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS object_storage_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  endpoint text,
  public_endpoint text,
  region text NOT NULL DEFAULT 'us-east-1',
  bucket text,
  access_key_id text,
  secret_encrypted text,
  secret_fingerprint text,
  encryption_key_id text,
  signed_url_ttl_seconds integer NOT NULL DEFAULT 900 CHECK(signed_url_ttl_seconds >= 60 AND signed_url_ttl_seconds <= 3600),
  status text NOT NULL DEFAULT 'not_configured' CHECK(status IN ('not_configured','configured','verified','error')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS runtime_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  upload_ttl_seconds integer NOT NULL DEFAULT 86400 CHECK(upload_ttl_seconds >= 300 AND upload_ttl_seconds <= 604800),
  signed_url_ttl_seconds integer NOT NULL DEFAULT 900 CHECK(signed_url_ttl_seconds >= 60 AND signed_url_ttl_seconds <= 3600),
  max_image_bytes integer NOT NULL DEFAULT 10000000 CHECK(max_image_bytes > 0),
  max_total_bytes integer NOT NULL DEFAULT 20000000 CHECK(max_total_bytes > 0),
  max_inputs integer NOT NULL DEFAULT 4 CHECK(max_inputs >= 1 AND max_inputs <= 32),
  provider_timeout_ms integer NOT NULL DEFAULT 300000 CHECK(provider_timeout_ms > 0),
  max_output_bytes integer NOT NULL DEFAULT 100000000 CHECK(max_output_bytes > 0 AND max_output_bytes <= 100000000),
  job_lease_ms integer NOT NULL DEFAULT 600000 CHECK(job_lease_ms > 0),
  revision integer NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS setup_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS setup_sessions_expiry_idx ON setup_sessions(expires_at) WHERE consumed_at IS NULL;
CREATE TABLE IF NOT EXISTS prompt_template_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'default',
  version integer NOT NULL DEFAULT 1 CHECK(version >= 1),
  is_active boolean NOT NULL DEFAULT false,
  index_path text,
  entry_count integer NOT NULL DEFAULT 0 CHECK(entry_count >= 0),
  content_digest text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(name, version)
);
CREATE TABLE IF NOT EXISTS prompt_template_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES prompt_template_sets(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  path text NOT NULL,
  content_sha256 text,
  instruction text,
  sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(set_id, name)
);
CREATE INDEX IF NOT EXISTS prompt_template_entries_set_idx ON prompt_template_entries(set_id, sort_order);
-- At most one active prompt template set. Normalize any legacy duplicates
-- first (keep the newest active set), then enforce with a partial unique index.
UPDATE prompt_template_sets SET is_active = false WHERE is_active = true AND id NOT IN (
  SELECT id FROM prompt_template_sets WHERE is_active = true ORDER BY version DESC, created_at DESC LIMIT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS prompt_template_sets_single_active_idx ON prompt_template_sets (is_active) WHERE is_active;
ALTER TABLE oauth_provider_settings ADD COLUMN IF NOT EXISTS encryption_key_id text;
ALTER TABLE onboarding_state ADD COLUMN IF NOT EXISTS claim_token_hash text;
ALTER TABLE onboarding_state ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;
ALTER TABLE onboarding_state ADD COLUMN IF NOT EXISTS claim_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE onboarding_state ADD COLUMN IF NOT EXISTS claim_consumed_at timestamptz;
DO $$ BEGIN ALTER TABLE onboarding_state ADD CONSTRAINT onboarding_state_claim_attempts_check CHECK(claim_attempts >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
INSERT INTO onboarding_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO app_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO smtp_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO object_storage_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO runtime_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
-- One-way deterministic backfill: existing deployments with an active admin are
-- complete; fresh installs stay pending. Never transitions complete -> pending,
-- so completed status survives later admin deletions.
UPDATE onboarding_state SET status='complete', completed_at=COALESCE(completed_at, now()), updated_at=now() WHERE singleton=true AND status='pending' AND EXISTS (SELECT 1 FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL);

-- ============================================================================
-- REMOVE BILLING/CREDITS (destructive, idempotent; children before parents)
-- Generations run free; the credit ledger, charge state machine and pricing
-- metadata are fully retired. This drops historical data by design.
-- ============================================================================
DROP TABLE IF EXISTS generation_charges CASCADE;
DROP TABLE IF EXISTS credit_ledger CASCADE;
DROP TABLE IF EXISTS credit_accounts CASCADE;
DROP TABLE IF EXISTS billing_settings CASCADE;
DO $$ BEGIN ALTER TABLE prompt_optimization_settings DROP CONSTRAINT IF EXISTS prompt_optimization_credits_per_job_check; EXCEPTION WHEN undefined_table THEN NULL; END $$;
ALTER TABLE prompt_optimization_settings DROP COLUMN IF EXISTS credits_per_job;
DO $$ BEGIN ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_configs_credits_per_image_check; EXCEPTION WHEN undefined_table THEN NULL; END $$;
ALTER TABLE model_configs DROP COLUMN IF EXISTS credits_per_image;
ALTER TABLE model_config_revisions DROP COLUMN IF EXISTS pricing;

-- ============================================================================
-- INSTALLED PROVIDER PLUGIN PACKAGES (plugin upload)
-- Admins upload self-contained provider plugin code packages (plugin_id@
-- plugin_version plus one .mjs artifact). The API validates the artifact and
-- stores it in object storage; apps/worker pulls it back out and dynamically
-- import()s it. api and worker are separate containers from separate images
-- that share no volume, so the code itself travels through S3 and this table
-- only carries its durable metadata plus the worker's local cache hints.
-- object_key is the private bucket key and MUST NEVER be returned to any
-- client: it is resolved server-side by the worker, clients only ever see
-- plugin_id / plugin_version / display_name.
-- ============================================================================
CREATE TABLE IF NOT EXISTS provider_plugins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id text NOT NULL,
  plugin_version text NOT NULL DEFAULT '1.0.0',
  kind text NOT NULL CHECK(kind IN ('media','language')),
  display_name text NOT NULL,
  description text,
  source text NOT NULL DEFAULT 'uploaded' CHECK(source IN ('builtin','uploaded')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled','failed')),
  object_key text NOT NULL,
  artifact_sha256 text NOT NULL,
  artifact_size_bytes integer NOT NULL CHECK(artifact_size_bytes > 0),
  manifest jsonb NOT NULL,
  allowed_hosts jsonb NOT NULL DEFAULT '[]',
  credential_schemas jsonb NOT NULL DEFAULT '[]',
  scan_report jsonb NOT NULL DEFAULT '[]',
  error_code text,
  error_message text,
  installed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(plugin_id, plugin_version)
);
-- Worker refresh query: usable packages for one kind (kind, status='active').
CREATE INDEX IF NOT EXISTS provider_plugins_kind_status_idx ON provider_plugins(kind, status) WHERE deleted_at IS NULL;
-- Artifact dedupe / integrity lookups by checksum.
CREATE INDEX IF NOT EXISTS provider_plugins_sha256_idx ON provider_plugins(artifact_sha256);
-- Incremental watermark refresh: "anything with updated_at after the last seen
-- high-water mark", so the worker never rescans the whole table.
CREATE INDEX IF NOT EXISTS provider_plugins_updated_at_idx ON provider_plugins(updated_at);

-- Which resolution path a model's plugin takes: 'builtin' ships in
-- packages/providers, 'installed' is served from a provider_plugins artifact.
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS plugin_source text NOT NULL DEFAULT 'builtin';
DO $$ BEGIN ALTER TABLE model_configs ADD CONSTRAINT model_configs_plugin_source_check CHECK(plugin_source IN ('builtin','installed')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Do NOT add another model_configs.plugin_id backfill here. The pre-existing
-- UPDATE above already stamps plugin_id onto EVERY row (language rows get
-- 'openai-language'/'anthropic-language', video '-video', image '-image'), and
-- none of those ids is registered anywhere. A non-null plugin_id therefore does
-- NOT mean "this model is bound to an installed plugin": consumers must gate on
-- actual registry/catalog membership (globalPluginRegistry.kindOf(...) or a
-- provider_plugins lookup), never on the column merely being non-null.

-- 12. Derived preview objects (worker-generated gallery thumbnails).
-- The library grid used to point every tile at the ORIGINAL object_key, so one
-- screen of 50 tiles downloaded 50 full-resolution images, and video tiles had
-- no poster at all (poster_object_key had readers but no writer) and each one
-- made the browser fetch video header bytes just to paint frame zero.
--
-- thumbnail_state is what makes backfill convergent: 'none' means "never
-- attempted", 'failed' means "attempted and could not be derived", so a
-- re-runnable sweep can select ('none','failed') and still terminate instead of
-- retrying a permanently unusable object forever.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS thumbnail_object_key text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS thumbnail_mime_type text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS thumbnail_width integer;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS thumbnail_height integer;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS thumbnail_state text NOT NULL DEFAULT 'none';
DO $$ BEGIN ALTER TABLE assets ADD CONSTRAINT assets_thumbnail_state_check CHECK(thumbnail_state IN ('none','ready','failed')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Backfill / maintenance scan: rows still missing a derived object.
CREATE INDEX IF NOT EXISTS assets_thumbnail_missing_idx ON assets(created_at) WHERE deleted_at IS NULL AND thumbnail_object_key IS NULL;

-- One asset can now own more than one object (original + derived preview; video
-- points poster_object_key and thumbnail_object_key at the SAME derived object).
-- asset_deletion_active_key was UNIQUE(asset_id) WHERE completed_at IS NULL, and
-- deletion enqueues one row per object_key with ON CONFLICT DO NOTHING, so every
-- second object of an asset was silently swallowed and leaked in the bucket
-- (pre-existing bug: it already applied to poster_object_key). Widening the key
-- to (asset_id, object_key) keeps the per-object dedupe while letting the
-- pending rows drain. Rebuilt in this same section so a partially migrated
-- database never has neither index.
DROP INDEX IF EXISTS asset_deletion_active_key;
CREATE UNIQUE INDEX IF NOT EXISTS asset_deletion_active_key ON asset_deletion_jobs(asset_id, object_key) WHERE completed_at IS NULL;
`
await db().query(sql)
console.log('database migration complete')
await db().end()
