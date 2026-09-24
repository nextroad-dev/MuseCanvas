/** Owner-scoped asset queries. */

export const LIBRARY_SELECT_COLUMNS = `SELECT a.id,a.object_key,a.media_kind,a.mime_type,a.width,a.height,a.duration_seconds,a.fps,a.codec,a.has_audio,a.size_bytes,a.poster_asset_id,a.poster_object_key,a.thumbnail_object_key,a.thumbnail_mime_type,a.thumbnail_width,a.thumbnail_height,a.created_at,COALESCE(po.input_prompt,a.prompt) input_prompt,po.final_prompt,s.allow_user_read_final_prompt`

/**
 * Shared by the page query and the count query, so a filter can never be applied
 * to one and quietly forgotten by the other.
 */
export const LIBRARY_FROM_CLAUSE = `FROM assets a JOIN generation_jobs j ON j.id=a.job_id LEFT JOIN prompt_optimizations po ON po.id=j.prompt_optimization_id AND po.deleted_at IS NULL CROSS JOIN prompt_optimization_settings s`
