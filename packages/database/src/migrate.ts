import { db } from './index'

const sql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('user','admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE user_status AS ENUM ('active','disabled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE registration_mode AS ENUM ('open','invite_only'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE model_adapter AS ENUM ('openai','seedream'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE job_status AS ENUM ('queued','running','retry_wait','succeeded','failed','canceled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE oauth_provider AS ENUM ('github','google'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text NOT NULL,role user_role NOT NULL DEFAULT 'user',status user_status NOT NULL DEFAULT 'active',session_version integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,deletion_requested_at timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_key ON users(lower(email)) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id),token_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz);
CREATE TABLE IF NOT EXISTS otp_challenges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text NOT NULL,code_hash text NOT NULL,invitation_code_hash text,expires_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),consumed_at timestamptz);
CREATE INDEX IF NOT EXISTS otp_email_idx ON otp_challenges(lower(email),created_at DESC);
CREATE TABLE IF NOT EXISTS registration_settings (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),mode registration_mode NOT NULL DEFAULT 'open',updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid);
INSERT INTO registration_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS invitations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text NOT NULL,code_hash text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),consumed_at timestamptz,revoked_at timestamptz);
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
`
await db().query(sql)
console.log('database migration complete')
await db().end()
