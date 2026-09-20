/** SQL shared by the job read and write paths. */

/**
 * Output rows for one job, excluding soft-deleted assets.
 *
 * `generation_outputs` is the join; the media columns come off `assets`, which is
 * why a deleted asset disappears from a job's result grid without erasing the job.
 */
export const jobOutputSelect = `SELECT go.asset_id,a.object_key,a.media_kind,a.mime_type,a.width,a.height,a.duration_seconds,a.fps,a.codec,a.has_audio,a.size_bytes,a.poster_asset_id,a.poster_object_key
  FROM generation_outputs go JOIN assets a ON a.id=go.asset_id WHERE go.job_id=$1 AND a.deleted_at IS NULL`
