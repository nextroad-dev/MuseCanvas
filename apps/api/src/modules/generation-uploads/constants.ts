export {
  MAX_UPLOAD_IMAGE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_INPUT_IMAGES,
} from '../../../../../packages/providers/src/index'

// Synchronous safe hard defaults for pure validation paths. Request-scoped
// handlers resolve the live values from runtime settings (DB first, legacy
// env second, these defaults last) and only fall back to these constants when
// the settings store is unreachable.
export const MAX_ACTIVE_UPLOADS = 20
export const GENERATION_UPLOAD_TTL_SECONDS = 86400
export const GENERATION_UPLOAD_SIGN_TTL_SECONDS = 900
export const GENERATION_UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const ALLOWED_MIME_TYPES: Record<string, true> = { 'image/png': true, 'image/jpeg': true }
