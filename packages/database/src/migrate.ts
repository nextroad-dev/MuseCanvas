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
CREATE TABLE IF NOT EXISTS smtp_settings (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),host text NOT NULL,port integer NOT NULL CHECK(port BETWEEN 1 AND 65535),tls_mode text NOT NULL CHECK(tls_mode IN ('implicit_tls','starttls','none')),from_address text NOT NULL,from_name text NOT NULL,username text NOT NULL,password_encrypted text,updated_by uuid REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now());
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
  timeout_ms integer NOT NULL DEFAULT 300000 CHECK(timeout_ms BETWEEN 1000 AND 300000),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE prompt_optimization_settings DROP COLUMN IF EXISTS max_output_chars;
INSERT INTO prompt_optimization_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
UPDATE prompt_optimization_settings SET timeout_ms=300000,updated_at=now() WHERE singleton=true AND timeout_ms=60000;
UPDATE model_configs SET sizes='["1024x1024","1280x720","720x1280","1280x960","960x1280","1536x1024","1024x1536","2048x2048","2304x1296","1296x2304","2048x1536","1536x2048","2496x1664","1664x2496","3072x3072","3072x1728","1728x3072","3072x2304","2304x3072","4096x4096","4096x2304","2304x4096","4096x3072","3072x4096"]'::jsonb,updated_at=now() WHERE preset_id IN ('seedream-4-0','seedream-4-5','seedream-5-lite') AND model_kind='image';

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
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS phase text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS optimization_mode text NOT NULL DEFAULT 'disabled';
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS prompt_optimization_id uuid REFERENCES prompt_optimizations(id);
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE generation_jobs ADD COLUMN IF NOT EXISTS provider_error jsonb;
DO $$ BEGIN ALTER TABLE generation_jobs ADD CONSTRAINT generation_jobs_optimization_mode_check CHECK(optimization_mode IN ('disabled','enabled')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`
await db().query(sql)
console.log('database migration complete')
await db().end()
