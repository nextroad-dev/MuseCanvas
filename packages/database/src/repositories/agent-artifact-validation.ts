import type { AgentArtifactAnchor, AgentArtifactDTO, CreateAgentArtifactReplyRequest, CreateAgentArtifactThreadRequest, ResolveAgentArtifactThreadRequest } from '@musecanvas/contracts'
import { AgentCoreError, agentCoreDecimal } from './agent-core'

export const AGENT_ARTIFACT_MESSAGE_BYTES = 8000
/** Includes the initial message; a thread can have at most 99 replies. */
export const AGENT_ARTIFACT_MAX_MESSAGES = 100
const invalid = (): never => { throw new AgentCoreError('INVALID_INPUT') }
export function artifactUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return invalid()
  return value.toLowerCase()
}
export function artifactIdentity(value: unknown): AgentArtifactDTO['id'] {
  if (typeof value !== 'string' || !/^(text|media):/i.test(value)) return invalid()
  const [kind, id, extra] = value.split(':')
  if (extra !== undefined) return invalid()
  return `${kind!.toLowerCase() as 'text' | 'media'}:${artifactUuid(id)}`
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return invalid()
  return value as Record<string, unknown>
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid()
  return value
}
function normalized(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return invalid()
  return value
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > max
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return invalid()
  return value
}
export function artifactAnchor(value: unknown): AgentArtifactAnchor {
  const v = object(value, ['kind', 'start', 'end', 'quote', 'x', 'y', 'width', 'height', 'timeMs'])
  switch (v.kind) {
    case 'whole': object(v, ['kind']); return { kind: 'whole' }
    case 'text': {
      object(v, ['kind', 'start', 'end', 'quote'])
      const start = integer(v.start), end = integer(v.end)
      if (start >= end) return invalid()
      // Whitespace is a valid exact selection even though a message body cannot be blank.
      if (typeof v.quote !== 'string' || !v.quote.length || v.quote.includes('\0') || Buffer.byteLength(v.quote, 'utf8') > 32000) return invalid()
      return { kind: 'text', start, end, quote: v.quote }
    }
    case 'image_point': object(v, ['kind', 'x', 'y']); return { kind: 'image_point', x: normalized(v.x), y: normalized(v.y) }
    case 'image_rect': {
      object(v, ['kind', 'x', 'y', 'width', 'height'])
      const x = normalized(v.x), y = normalized(v.y), width = normalized(v.width), height = normalized(v.height)
      if (width === 0 || height === 0 || x + width > 1 || y + height > 1) return invalid()
      return { kind: 'image_rect', x, y, width, height }
    }
    case 'video': object(v, ['kind', 'timeMs']); return { kind: 'video', timeMs: integer(v.timeMs) }
    default: return invalid()
  }
}
export function validateArtifactAnchor(artifact: AgentArtifactDTO, value: unknown): AgentArtifactAnchor {
  const anchor = artifactAnchor(value)
  if (anchor.kind === 'whole') return anchor
  if (anchor.kind === 'text') {
    if (artifact.kind !== 'text' || anchor.end > artifact.content.length || artifact.content.slice(anchor.start, anchor.end) !== anchor.quote) return invalid()
    // Do not allow selecting half a surrogate pair; offsets still count UTF-16 units.
    const split = (i: number) => i > 0 && i < artifact.content.length && /[\uD800-\uDBFF]/u.test(artifact.content[i - 1]!) && /[\uDC00-\uDFFF]/u.test(artifact.content[i]!)
    if (split(anchor.start) || split(anchor.end)) return invalid()
  } else if (anchor.kind === 'video') {
    if (artifact.kind !== 'video' || artifact.durationMs === null || anchor.timeMs > artifact.durationMs) return invalid()
  } else if (artifact.kind !== 'image') return invalid()
  return anchor
}
export function artifactThreadInput(value: unknown): CreateAgentArtifactThreadRequest {
  const v = object(value, ['clientRequestId', 'version', 'anchor', 'body'])
  if (v.version !== 1) return invalid()
  return { clientRequestId: artifactUuid(v.clientRequestId), version: 1, anchor: artifactAnchor(v.anchor), body: text(v.body, AGENT_ARTIFACT_MESSAGE_BYTES) }
}
export function artifactReplyInput(value: unknown): CreateAgentArtifactReplyRequest {
  const v = object(value, ['clientRequestId', 'body'])
  return { clientRequestId: artifactUuid(v.clientRequestId), body: text(v.body, AGENT_ARTIFACT_MESSAGE_BYTES) }
}
export function artifactResolveInput(value: unknown): ResolveAgentArtifactThreadRequest {
  const v = object(value, ['resolved'])
  if (typeof v.resolved !== 'boolean') return invalid()
  return { resolved: v.resolved }
}
interface ArtifactCursor { kind: 'artifacts' | 'threads'; sessionId: string; artifactId?: string; sequence: string; id: string }
export function encodeArtifactCursor(value: ArtifactCursor): string { return Buffer.from(JSON.stringify(value)).toString('base64url') }
export function decodeArtifactCursor(value: string | undefined, kind: ArtifactCursor['kind'], sessionId: string, artifactId?: string): ArtifactCursor | undefined {
  if (value === undefined) return undefined
  if (!value.length || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid()
  try {
    const v = object(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')), ['kind', 'sessionId', 'artifactId', 'sequence', 'id'])
    if (v.kind !== kind || v.sessionId !== sessionId || v.artifactId !== artifactId || typeof v.sequence !== 'string') return invalid()
    const sequence = agentCoreDecimal(v.sequence)
    if (sequence === '0') return invalid()
    const id = kind === 'artifacts' ? artifactIdentity(v.id) : artifactUuid(v.id)
    const decoded: ArtifactCursor = { kind, sessionId, ...(artifactId ? { artifactId } : {}), sequence, id }
    if (encodeArtifactCursor(decoded) !== value) return invalid()
    return decoded
  } catch { return invalid() }
}
export function artifactPageQuery(url: URL) {
  if (url.search.length > 1024) return invalid()
  for (const [key] of url.searchParams) if (!['limit', 'cursor'].includes(key) || url.searchParams.getAll(key).length !== 1) return invalid()
  const raw = url.searchParams.get('limit')
  if (raw !== null && !/^[1-9][0-9]{0,2}$/.test(raw)) return invalid()
  const limit = raw === null ? 50 : Number(raw)
  if (limit > 100) return invalid()
  const cursor = url.searchParams.get('cursor') ?? undefined
  if (cursor !== undefined && (!cursor.length || cursor.length > 512)) return invalid()
  return { limit, cursor }
}
