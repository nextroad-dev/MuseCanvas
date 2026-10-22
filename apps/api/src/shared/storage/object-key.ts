import { STORAGE_KEY_INVALID, StorageDriverError } from './types'

// Key rules for the local-disk driver. S3 keys are not affected: S3 treats them as opaque strings.
// Keys are server-generated (user id / run id / uuid segments), so these rules reject malformed
// or hostile input rather than normalising it.

export const OBJECT_KEY_MAX_LENGTH = 1024
/** Sidecar metadata lives next to each object as `<key>.meta.json`; no object key may end that way. */
export const SIDECAR_SUFFIX = '.meta.json'
/** Windows device names, reserved as a segment or as the stem before the first dot, in any letter case. */
const WINDOWS_RESERVED_STEMS = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from('123456789¹²³').flatMap(digit => [`COM${digit}`, `LPT${digit}`]),
])

// Control characters, backslash (Windows separator) and colon (drive letters, alternate streams).
function hasUnsafeCharacter(key: string): boolean {
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index)
    if (code < 0x20 || code === 0x7f || code === 0x5c || code === 0x3a) return true
  }
  return false
}

function isReservedDeviceSegment(segment: string): boolean {
  const dot = segment.indexOf('.')
  const stem = (dot === -1 ? segment : segment.slice(0, dot)).replace(/ +$/, '').toUpperCase()
  return WINDOWS_RESERVED_STEMS.has(stem)
}

export function invalidObjectKey(): StorageDriverError {
  return new StorageDriverError(STORAGE_KEY_INVALID)
}

/** Returns the key unchanged when it is a safe relative path made of plain segments. Throws STORAGE_KEY_INVALID otherwise. */
export function assertLocalObjectKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.length > OBJECT_KEY_MAX_LENGTH) throw invalidObjectKey()
  if (hasUnsafeCharacter(key) || key.startsWith('/')) throw invalidObjectKey()
  const segments = key.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw invalidObjectKey()
    // Windows silently strips trailing dots and spaces, which would alias two different keys.
    if (segment.endsWith('.') || segment.endsWith(' ')) throw invalidObjectKey()
    if (isReservedDeviceSegment(segment)) throw invalidObjectKey()
  }
  // Case-insensitive: on a case-folding volume `x.META.JSON` would resolve to the sidecar of `x`.
  if (segments[segments.length - 1].toUpperCase().endsWith(SIDECAR_SUFFIX.toUpperCase())) throw invalidObjectKey()
  return key
}
