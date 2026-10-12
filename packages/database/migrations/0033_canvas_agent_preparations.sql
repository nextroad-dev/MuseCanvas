-- Scoped Agent edit preparation only. 0001-0032 and existing rows are untouched.
CREATE TABLE IF NOT EXISTS canvas_agent_preparations (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  canvas_id uuid NOT NULL,
  created_by uuid NOT NULL,
  turn_id uuid NOT NULL,
  tool_call_id text NOT NULL CHECK(length(tool_call_id) BETWEEN 1 AND 512),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  request_snapshot jsonb NOT NULL CHECK(jsonb_typeof(request_snapshot) = 'object'),
  mask_upload_id uuid NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'preparing' CHECK(status IN ('preparing','ready')),
  lease_token uuid,
  lease_expires_at timestamptz,
  artifact jsonb,
  ready_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(session_id,canvas_id,created_by) REFERENCES canvas_agent_sessions(id,canvas_id,created_by) ON DELETE CASCADE,
  FOREIGN KEY(turn_id,session_id) REFERENCES canvas_agent_turns(id,session_id) ON DELETE CASCADE,
  UNIQUE(canvas_id,turn_id,tool_call_id),
  CHECK(expires_at > created_at),
  CHECK((request_snapshot ?& ARRAY['modelId','modelConfigDigest','prompt','parameters','sourceAssetId','sourceNodeId','selection','sourceChecksum']
    AND request_snapshot - ARRAY['modelId','modelConfigDigest','prompt','parameters','sourceAssetId','sourceNodeId','selection','sourceChecksum'] = '{}'::jsonb
    AND jsonb_typeof(request_snapshot->'modelId')='string' AND request_snapshot->>'modelId' ~ '^[0-9a-f-]{36}$'
    AND jsonb_typeof(request_snapshot->'modelConfigDigest')='string' AND request_snapshot->>'modelConfigDigest' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(request_snapshot->'sourceChecksum')='string' AND request_snapshot->>'sourceChecksum' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(request_snapshot->'sourceAssetId')='string' AND request_snapshot->>'sourceAssetId' ~ '^[0-9a-f-]{36}$'
    AND jsonb_typeof(request_snapshot->'sourceNodeId') IN ('null','string')
    AND jsonb_typeof(request_snapshot->'prompt')='string' AND jsonb_typeof(request_snapshot->'parameters')='object'
    AND jsonb_typeof(request_snapshot->'selection')='object') IS TRUE),
  CHECK((status='preparing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND ready_snapshot IS NULL)
     OR (status='ready' AND lease_token IS NULL AND lease_expires_at IS NULL AND ready_snapshot IS NOT NULL AND artifact IS NOT NULL))
);
CREATE OR REPLACE FUNCTION canvas_agent_valid_preparation_artifact(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  RETURN (jsonb_typeof(value)='object' AND value ?& ARRAY['checksum','sizeBytes','width','height','sourceChecksum']
    AND value - ARRAY['checksum','sizeBytes','width','height','sourceChecksum'] = '{}'::jsonb
    AND jsonb_typeof(value->'checksum')='string' AND jsonb_typeof(value->'sourceChecksum')='string'
    AND value->>'checksum' ~ '^[0-9a-f]{64}$' AND value->>'sourceChecksum' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(value->'sizeBytes')='number' AND value->>'sizeBytes' ~ '^[1-9][0-9]*$'
    AND (value->>'sizeBytes')::numeric <= 52428800
    AND jsonb_typeof(value->'width')='number' AND value->>'width' ~ '^[1-9][0-9]*$' AND (value->>'width')::numeric <= 32768
    AND jsonb_typeof(value->'height')='number' AND value->>'height' ~ '^[1-9][0-9]*$' AND (value->>'height')::numeric <= 32768) IS TRUE;
END $$;
ALTER TABLE canvas_agent_preparations DROP CONSTRAINT IF EXISTS canvas_agent_preparation_artifact_check;
ALTER TABLE canvas_agent_preparations ADD CONSTRAINT canvas_agent_preparation_artifact_check CHECK(canvas_agent_valid_preparation_artifact(artifact));
CREATE OR REPLACE FUNCTION canvas_agent_valid_preparation_snapshot(value jsonb, mask_id uuid, request jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE generation jsonb; inputs jsonb;
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  generation := value->'normalizedRequest'; inputs := generation->'inputs';
  RETURN (jsonb_typeof(value)='object' AND value ?& ARRAY['normalizedRequest','editMetadata']
    AND value - ARRAY['normalizedRequest','editMetadata'] = '{}'::jsonb
    AND jsonb_typeof(generation)='object' AND generation ?& ARRAY['modelId','prompt','parameters','inputs','mode']
    AND generation - ARRAY['modelId','prompt','parameters','inputs','mode'] = '{}'::jsonb
    AND generation->>'modelId'=request->>'modelId' AND generation->>'mode'='inpaint'
    AND jsonb_typeof(generation->'prompt')='string' AND jsonb_typeof(generation->'parameters')='object'
    AND jsonb_typeof(generation->'parameters'->'count')='number' AND generation->'parameters'->>'count'='1' AND canvas_agent_valid_inputs(inputs)
    AND jsonb_array_length(inputs)=2
    AND inputs->0->>'assetId'=request->>'sourceAssetId' AND inputs->0->>'role'='reference_image' AND inputs->0->>'position'='0'
    AND inputs->1->>'uploadId'=mask_id::text AND inputs->1->>'role'='mask' AND inputs->1->>'position'='1'
    AND value->'editMetadata' IS NOT NULL AND value->'editMetadata'<>'null'::jsonb
    AND canvas_agent_valid_edit_metadata(value->'editMetadata')) IS TRUE;
END $$;
ALTER TABLE canvas_agent_preparations DROP CONSTRAINT IF EXISTS canvas_agent_preparation_snapshot_check;
ALTER TABLE canvas_agent_preparations ADD CONSTRAINT canvas_agent_preparation_snapshot_check CHECK(canvas_agent_valid_preparation_snapshot(ready_snapshot,mask_upload_id,request_snapshot));
CREATE OR REPLACE FUNCTION canvas_agent_guard_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['status','lease_token','lease_expires_at','artifact','ready_snapshot','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','lease_token','lease_expires_at','artifact','ready_snapshot','updated_at'])
    OR (OLD.artifact IS NOT NULL AND NEW.artifact IS DISTINCT FROM OLD.artifact)
    OR (OLD.status='ready' AND (NEW.status,NEW.artifact,NEW.ready_snapshot,NEW.lease_token,NEW.lease_expires_at)
      IS DISTINCT FROM (OLD.status,OLD.artifact,OLD.ready_snapshot,OLD.lease_token,OLD.lease_expires_at)) THEN
    RAISE EXCEPTION 'immutable canvas agent preparation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS canvas_agent_preparation_immutable ON canvas_agent_preparations;
CREATE TRIGGER canvas_agent_preparation_immutable BEFORE UPDATE ON canvas_agent_preparations FOR EACH ROW EXECUTE FUNCTION canvas_agent_guard_preparation();
-- No FK to TTL uploads: cleanup may delete expired upload rows without changing the frozen snapshot.
