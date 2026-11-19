import { createHash } from 'node:crypto'
import type { JsonValue } from '@musecanvas/contracts'

/** Persisted Agent identities depend on these exact bytes: sort object keys
 * lexically, preserve array order and use JSON.stringify for keys and scalars.
 * Keep compatible with existing request, approval and checkpoint digests. */
export function canonicalJsonDigest(value: JsonValue): string {
  function canonical(item: JsonValue): string {
    if (item === null || typeof item !== 'object') return JSON.stringify(item)
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key]!)}`).join(',')}}`
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}
