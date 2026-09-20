import { signedAssetUrl } from '../../shared/services'

/**
 * Gallery row → the shape `apps/web-next` renders.
 *
 * This projection deliberately lives here rather than in `shared/dto.ts`: it is
 * the only place that presigns three objects per row, and the reuse below is a
 * cost decision, not an aesthetic one.
 */
export async function libraryAssetDto(row: Record<string, unknown>) {
  const mediaKind = (row.media_kind as string) || 'image'
  const url = await signedAssetUrl(row.object_key as string)
  const thumbnailKey = (row.thumbnail_object_key as string) || undefined
  const posterKey = (row.poster_object_key as string) || undefined
  const thumbnailUrl = thumbnailKey ? await signedAssetUrl(thumbnailKey) : undefined
  // A video's poster and its gallery preview ARE the same object, so reuse
  // the signature instead of presigning a second time.
  const posterUrl = posterKey ? (posterKey === thumbnailKey ? thumbnailUrl : await signedAssetUrl(posterKey)) : undefined
  return {
    id: row.id,
    mediaKind,
    prompt: row.input_prompt,
    inputPrompt: row.input_prompt,
    finalPrompt: row.allow_user_read_final_prompt ? row.final_prompt || null : null,
    canReadFinalPrompt: !!row.allow_user_read_final_prompt,
    url,
    downloadUrl: url,
    imageUrl: url,
    posterUrl,
    posterAssetId: (row.poster_asset_id as string) || undefined,
    thumbnailUrl,
    thumbnailMimeType: (row.thumbnail_mime_type as string) || undefined,
    thumbnailWidth: row.thumbnail_width !== null && row.thumbnail_width !== undefined ? Number(row.thumbnail_width) : undefined,
    thumbnailHeight: row.thumbnail_height !== null && row.thumbnail_height !== undefined ? Number(row.thumbnail_height) : undefined,
    mimeType: row.mime_type,
    width: row.width !== null && row.width !== undefined ? Number(row.width) : undefined,
    height: row.height !== null && row.height !== undefined ? Number(row.height) : undefined,
    durationSeconds: row.duration_seconds !== null && row.duration_seconds !== undefined ? Number(row.duration_seconds) : undefined,
    fps: row.fps !== null && row.fps !== undefined ? Number(row.fps) : undefined,
    codec: (row.codec as string) || undefined,
    hasAudio: typeof row.has_audio === 'boolean' ? row.has_audio as boolean : undefined,
    sizeBytes: row.size_bytes !== undefined ? Number(row.size_bytes) : undefined,
    createdAt: (row.created_at as Date).toISOString(),
  }
}
