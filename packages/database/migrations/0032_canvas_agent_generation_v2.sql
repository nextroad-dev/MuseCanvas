-- Canvas Agent v2. Incremental and rerunnable; never update v1 rows/digests/keys.
-- Requires 0031_canvas_agent.sql. Run in the migration runner's transaction.
ALTER TABLE canvas_agent_turns ADD COLUMN IF NOT EXISTS request_snapshot jsonb;
ALTER TABLE canvas_agent_turns ADD COLUMN IF NOT EXISTS scene_commit_revision integer;
ALTER TABLE canvas_agent_turns ADD COLUMN IF NOT EXISTS scene_commit_at timestamptz;
ALTER TABLE canvas_agent_turns ADD COLUMN IF NOT EXISTS scene_commit_ops jsonb;
ALTER TABLE canvas_agent_pending_jobs ADD COLUMN IF NOT EXISTS request_version integer NOT NULL DEFAULT 1;
ALTER TABLE canvas_agent_pending_jobs ADD COLUMN IF NOT EXISTS normalized_request jsonb;
ALTER TABLE canvas_agent_pending_jobs ADD COLUMN IF NOT EXISTS normalized_inputs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE canvas_agent_pending_jobs ADD COLUMN IF NOT EXISTS edit_metadata jsonb;

-- Only replace the original single-source constraint, not unrelated historical constraints.
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'canvas_agent_pending_jobs'::regclass AND contype = 'c'
      AND conname <> 'canvas_agent_pending_jobs_version_sources_check'
      AND pg_get_constraintdef(oid) LIKE '%source_node_id%'
      AND pg_get_constraintdef(oid) LIKE '%source_asset_id%'
  LOOP
    EXECUTE 'ALTER TABLE canvas_agent_pending_jobs DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;
ALTER TABLE canvas_agent_pending_jobs DROP CONSTRAINT IF EXISTS canvas_agent_pending_jobs_version_sources_check;
ALTER TABLE canvas_agent_pending_jobs ADD CONSTRAINT canvas_agent_pending_jobs_version_sources_check CHECK ((
  (request_version = 1 AND normalized_request IS NULL AND normalized_inputs = '[]'::jsonb AND edit_metadata IS NULL AND (
    (kind = 'image' AND source_node_id IS NULL AND source_asset_id IS NULL)
    OR (kind = 'video' AND source_node_id IS NOT NULL AND source_asset_id IS NOT NULL)
  )) OR (request_version = 2 AND normalized_request IS NOT NULL
    AND jsonb_typeof(normalized_request) = 'object'
    AND normalized_request ?& ARRAY['modelId','prompt','parameters','mode','inputs']
    AND normalized_request - ARRAY['modelId','prompt','parameters','mode','inputs'] = '{}'::jsonb
    AND jsonb_typeof(normalized_request->'modelId') = 'string'
    AND jsonb_typeof(normalized_request->'prompt') = 'string'
    AND jsonb_typeof(normalized_request->'mode') = 'string'
    AND normalized_request->>'modelId' = model_id::text
    AND normalized_request->>'prompt' = prompt
    AND normalized_request->'parameters' = parameters
    AND normalized_request->'inputs' = normalized_inputs
    AND jsonb_typeof(normalized_inputs) = 'array'
    AND jsonb_array_length(normalized_inputs) <= 16
    AND ((kind = 'image' AND normalized_request->>'mode' IN ('text_to_image','image_to_image','inpaint'))
      OR (kind = 'video' AND normalized_request->>'mode' IN ('text_to_video','image_to_video')))
  )
) IS TRUE);

-- A pure validator keeps item checks out of mutable provider/config state.
CREATE OR REPLACE FUNCTION canvas_agent_valid_inputs(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; ref text; seen text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  FOR item IN SELECT jsonb_array_elements(value) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR item - ARRAY['uploadId','assetId','role','position'] <> '{}'::jsonb
      OR NOT (item ?& ARRAY['role','position'])
      OR (item ? 'uploadId') = (item ? 'assetId')
      OR jsonb_typeof(item->'role') IS DISTINCT FROM 'string'
      OR length(item->>'role') NOT BETWEEN 1 AND 64
      OR jsonb_typeof(item->'position') IS DISTINCT FROM 'number'
      OR NOT ((item->>'position') ~ '^[0-9]+$') THEN RETURN false; END IF;
    IF (item->>'position')::numeric NOT BETWEEN 0 AND 15 THEN RETURN false; END IF;
    ref := CASE WHEN item ? 'uploadId' THEN 'uploadId' ELSE 'assetId' END;
    IF jsonb_typeof(item->ref) IS DISTINCT FROM 'string'
      OR NOT ((item->>ref) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR (ref || ':' || (item->>ref)) = ANY(seen) THEN RETURN false; END IF;
    seen := array_append(seen, ref || ':' || (item->>ref));
  END LOOP;
  RETURN true;
END $$;
ALTER TABLE canvas_agent_pending_jobs DROP CONSTRAINT IF EXISTS canvas_agent_pending_inputs_check;
ALTER TABLE canvas_agent_pending_jobs ADD CONSTRAINT canvas_agent_pending_inputs_check CHECK (canvas_agent_valid_inputs(normalized_inputs));

CREATE OR REPLACE FUNCTION canvas_agent_valid_edit_metadata(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE selection jsonb; key text;
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR NOT (value ?& ARRAY['selection','sourceWidth','sourceHeight'])
    OR value - ARRAY['selection','sourceWidth','sourceHeight'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['sourceWidth','sourceHeight'] LOOP
    IF jsonb_typeof(value->key) IS DISTINCT FROM 'number' OR NOT ((value->>key) ~ '^[0-9]+$') THEN RETURN false; END IF;
    IF (value->>key)::numeric NOT BETWEEN 1 AND 32768 THEN RETURN false; END IF;
  END LOOP;
  selection := value->'selection';
  IF jsonb_typeof(selection) IS DISTINCT FROM 'object'
    OR NOT (selection ?& ARRAY['x','y','width','height'])
    OR selection - ARRAY['x','y','width','height'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['x','y','width','height'] LOOP
    IF jsonb_typeof(selection->key) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    IF (selection->>key)::numeric < 0 THEN RETURN false; END IF;
  END LOOP;
  RETURN (selection->>'width')::numeric > 0 AND (selection->>'height')::numeric > 0
    AND (selection->>'x')::numeric + (selection->>'width')::numeric <= (value->>'sourceWidth')::numeric
    AND (selection->>'y')::numeric + (selection->>'height')::numeric <= (value->>'sourceHeight')::numeric;
END $$;
ALTER TABLE canvas_agent_pending_jobs DROP CONSTRAINT IF EXISTS canvas_agent_pending_edit_metadata_check;
ALTER TABLE canvas_agent_pending_jobs ADD CONSTRAINT canvas_agent_pending_edit_metadata_check CHECK ((
  canvas_agent_valid_edit_metadata(edit_metadata) AND (edit_metadata IS NULL OR (request_version = 2 AND kind = 'image' AND normalized_request->>'mode' = 'inpaint'))
) IS TRUE);
ALTER TABLE canvas_agent_turns DROP CONSTRAINT IF EXISTS canvas_agent_turn_snapshot_check;
ALTER TABLE canvas_agent_turns ADD CONSTRAINT canvas_agent_turn_snapshot_check CHECK ((request_snapshot IS NULL OR (
  jsonb_typeof(request_snapshot) = 'object' AND request_snapshot ?& ARRAY['kind','messageId','baseRevision','sceneCommitMode']
  AND request_snapshot->>'kind' IN ('user','job_event') AND request_snapshot->>'messageId' = message_id::text
  AND jsonb_typeof(request_snapshot->'baseRevision') = 'number'
  AND request_snapshot->>'baseRevision' ~ '^[1-9][0-9]*$'
  AND request_snapshot->>'sceneCommitMode' IN ('client-managed','agent-managed')
)) IS TRUE);
ALTER TABLE canvas_agent_turns DROP CONSTRAINT IF EXISTS canvas_agent_turn_scene_commit_check;
ALTER TABLE canvas_agent_turns ADD CONSTRAINT canvas_agent_turn_scene_commit_check CHECK ((
  (scene_commit_revision IS NULL AND scene_commit_at IS NULL AND scene_commit_ops IS NULL)
  OR (scene_commit_revision > 0 AND scene_commit_at IS NOT NULL AND scene_commit_ops IS NOT NULL
    AND jsonb_typeof(scene_commit_ops) = 'array' AND status <> 'running'
    AND request_snapshot IS NOT NULL AND request_snapshot->>'sceneCommitMode' = 'agent-managed')
) IS TRUE);

CREATE OR REPLACE FUNCTION canvas_agent_guard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'canvas_agent_turns' THEN
    IF (to_jsonb(NEW) - ARRAY['status','lease_token','lease_expires_at','timeout_ms','started_at','completed_at','error_code','scene_commit_revision','scene_commit_at','scene_commit_ops'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','lease_token','lease_expires_at','timeout_ms','started_at','completed_at','error_code','scene_commit_revision','scene_commit_at','scene_commit_ops']) THEN
      RAISE EXCEPTION 'immutable canvas agent turn';
    END IF;
    IF OLD.scene_commit_revision IS NOT NULL AND
      (NEW.scene_commit_revision, NEW.scene_commit_at, NEW.scene_commit_ops) IS DISTINCT FROM
      (OLD.scene_commit_revision, OLD.scene_commit_at, OLD.scene_commit_ops) THEN
      RAISE EXCEPTION 'immutable canvas agent scene commit';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['status','lease_token','lease_expires_at','job_id','ops','updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','lease_token','lease_expires_at','job_id','ops','updated_at']) THEN
      RAISE EXCEPTION 'immutable canvas agent pending snapshot';
    END IF;
  END IF;
  RETURN NEW;
END $$;
