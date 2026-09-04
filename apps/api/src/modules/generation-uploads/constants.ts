export {
  MAX_UPLOAD_IMAGE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_INPUT_IMAGES,
} from '../../../../../packages/providers/src/index'

function secondsSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`INVALID_${name}`)
  }
  return parsed
}
export const MAX_ACTIVE_UPLOADS = 20
export const GENERATION_UPLOAD_TTL_SECONDS = secondsSetting('GENERATION_UPLOAD_TTL_SECONDS', 86400, 300, 604800)
export const GENERATION_UPLOAD_SIGN_TTL_SECONDS = secondsSetting('GENERATION_UPLOAD_SIGN_TTL_SECONDS', 900, 60, 3600)
export const GENERATION_UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const ALLOWED_MIME_TYPES: Record<string, true> = { 'image/png': true, 'image/jpeg': true }
