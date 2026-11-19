/** $1 owner, $2 session. Only committed result + tool/job/output/owner proof may read media.
 * Deduplication precedes pagination; the first proven item fixes an asset's position.
 * Snapshot fallback contains safe metadata only and can never authorize media bytes.
 */
export const agentArtifactProjection = `WITH text_artifacts AS (
  SELECT 'text:' || i.id::text AS artifact_id,i.session_id,i.turn_id,i.id AS source_item_id,
    i.sequence AS source_sequence,i.created_at AS source_created_at,'text'::text AS kind,
    i.payload->>'content' AS content,NULL::uuid AS asset_id,true AS available,
    NULL::integer AS width,NULL::integer AS height,NULL::numeric AS duration_ms
  FROM agent_items i
  JOIN agent_sessions s ON s.id=i.session_id AND s.owner_id=$1
  JOIN agent_turns t ON t.id=i.turn_id AND t.session_id=i.session_id
  WHERE i.session_id=$2 AND i.item_type='assistant_message'
    AND jsonb_typeof(i.payload->'content')='string' AND i.payload->>'content' ~ '[^[:space:]]'
), media_candidates AS (
  SELECT 'media:' || a.id::text AS artifact_id,i.session_id,i.turn_id,i.id AS source_item_id,
    i.sequence AS source_sequence,i.created_at AS source_created_at,a.media_kind AS kind,
    NULL::text AS content,a.id AS asset_id,(a.deleted_at IS NULL AND j.deleted_at IS NULL) AS available,
    a.width,a.height,
    CASE WHEN a.duration_seconds >= 0 AND a.duration_seconds*1000 <= 9007199254740991
      THEN floor(a.duration_seconds*1000) ELSE NULL END AS duration_ms,
    row_number() OVER (PARTITION BY a.id ORDER BY i.sequence,i.id) AS occurrence
  FROM agent_items i
  JOIN agent_sessions s ON s.id=i.session_id AND s.owner_id=$1
  JOIN agent_turns t ON t.id=i.turn_id AND t.session_id=i.session_id
  JOIN agent_tool_calls c ON c.id=i.tool_call_id AND c.turn_id=i.turn_id AND c.session_id=i.session_id
  JOIN agent_tool_job_links l ON l.tool_call_id=c.id AND l.turn_id=c.turn_id AND l.session_id=c.session_id AND l.owner_id=s.owner_id
  JOIN generation_jobs j ON j.id=l.media_job_id AND j.created_by=l.owner_id
  JOIN generation_outputs o ON o.job_id=j.id
  JOIN assets a ON a.id=o.asset_id AND a.job_id=j.id AND a.created_by=s.owner_id
  WHERE i.session_id=$2 AND i.item_type='tool_result' AND l.dependency_role='output'
    AND c.status IN ('completed','failed','cancelled') AND i.payload->>'status'=c.status
    AND i.payload->'result'=c.result AND j.status='succeeded' AND j.completed_at IS NOT NULL
    AND a.media_kind IN ('image','video')
    AND (
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.payload->'result'->'jobs')='array'
        THEN i.payload->'result'->'jobs' ELSE '[]'::jsonb END) r(job)
        WHERE r.job->>'jobId'=j.id::text AND r.job->>'status'='succeeded'
          AND (r.job->'assetIds') @> jsonb_build_array(a.id::text))
      OR (c.status='completed'
        AND (i.payload->'result'->'assetIds') @> jsonb_build_array(a.id::text)
        AND (i.payload->'result'->'jobIds') @> jsonb_build_array(j.id::text))
    )
), live_artifacts AS (
  SELECT * FROM text_artifacts
  UNION ALL
  SELECT artifact_id,session_id,turn_id,source_item_id,source_sequence,source_created_at,kind,content,asset_id,available,width,height,duration_ms
    FROM media_candidates WHERE occurrence=1
), artifacts AS (
  SELECT p.artifact_id,p.session_id,p.turn_id,p.source_item_id,p.source_sequence,p.source_created_at,p.kind,p.content,p.asset_id,
    COALESCE(l.available,false) AS available,p.width,p.height,p.duration_ms
  FROM agent_artifact_snapshots p LEFT JOIN live_artifacts l ON l.artifact_id=p.artifact_id
  WHERE p.owner_id=$1 AND p.session_id=$2
  UNION ALL
  SELECT l.* FROM live_artifacts l WHERE NOT EXISTS (
    SELECT 1 FROM agent_artifact_snapshots p WHERE p.owner_id=$1 AND p.session_id=$2 AND p.artifact_id=l.artifact_id)
)`
