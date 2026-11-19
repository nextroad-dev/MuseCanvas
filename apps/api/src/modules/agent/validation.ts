import { AGENT_MESSAGE_MAX_ATTACHMENTS, type AgentMessageAttachment, type AgentBudgetDTO, type AgentDefinitionBudgetPolicy, type CreateAgentMessageRequest, type CreateAgentSessionRequest, type ResolveAgentApprovalRequest } from '@musecanvas/contracts'
import { AgentCoreError, agentCoreDecimal } from '@musecanvas/database'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new AgentCoreError('INVALID_INPUT')
  return value.toLowerCase()
}
export function storageString(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    || Buffer.byteLength(value, 'utf8') > maxBytes) throw new AgentCoreError('INVALID_INPUT')
  return value
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new AgentCoreError('INVALID_INPUT')
  return value as Record<string, unknown>
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new AgentCoreError('INVALID_INPUT')
  return value
}
export function createSessionInput(value: unknown): CreateAgentSessionRequest {
  const v = object(value, ['clientRequestId', 'agentDefinitionId', 'definitionVersion', 'defaultCanvasId'])
  const clientRequestId = storageString(v.clientRequestId, 128)
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(clientRequestId)) throw new AgentCoreError('INVALID_INPUT')
  return { clientRequestId, agentDefinitionId: uuid(v.agentDefinitionId), definitionVersion: integer(v.definitionVersion, 1, 2147483647),
    ...(v.defaultCanvasId === undefined ? {} : { defaultCanvasId: uuid(v.defaultCanvasId) }) }
}
export function messageInput(value: unknown): CreateAgentMessageRequest {
  const v = object(value, ['clientMessageId', 'content', 'attachments'])
  const content = storageString(v.content, 32000)
  if (!content.trim()) throw new AgentCoreError('INVALID_INPUT')
  let attachments: AgentMessageAttachment[] | undefined
  if (v.attachments !== undefined) {
    if (!Array.isArray(v.attachments) || v.attachments.length > AGENT_MESSAGE_MAX_ATTACHMENTS) throw new AgentCoreError('INVALID_INPUT')
    const seen = new Set<string>()
    attachments = v.attachments.map(raw => {
      const a = object(raw, ['kind', 'id', 'role', 'checksum', 'width', 'height', 'mimeType', 'preparationVersion', 'sourceChecksum'])
      if ((a.kind !== 'upload' && a.kind !== 'asset') || (a.role !== 'reference_image' && a.role !== 'mask')
        || !/^[0-9a-f]{64}$/i.test(String(a.checksum)) || !['image/png', 'image/jpeg'].includes(String(a.mimeType))) throw new AgentCoreError('INVALID_INPUT')
      const id = uuid(a.id)
      if (seen.has(`${a.kind}:${id}`)) throw new AgentCoreError('INVALID_INPUT')
      seen.add(`${a.kind}:${id}`)
      const width = integer(a.width, 1, 32768), height = integer(a.height, 1, 32768)
      if (a.role === 'mask' && (a.kind !== 'upload' || a.preparationVersion !== 1 || !/^[0-9a-f]{64}$/i.test(String(a.sourceChecksum)))) throw new AgentCoreError('INVALID_INPUT')
      if (a.role === 'reference_image' && (a.preparationVersion !== undefined || a.sourceChecksum !== undefined)) throw new AgentCoreError('INVALID_INPUT')
      return { kind: a.kind as 'upload' | 'asset', id, role: a.role as 'reference_image' | 'mask', checksum: String(a.checksum).toLowerCase(), width, height, mimeType: a.mimeType as 'image/png' | 'image/jpeg',
        ...(a.preparationVersion === 1 ? { preparationVersion: 1 as const, sourceChecksum: String(a.sourceChecksum).toLowerCase() } : {}) }
    }).sort((a, b) => a.role.localeCompare(b.role) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
  }
  return { clientMessageId: uuid(v.clientMessageId), content, ...(attachments?.length ? { attachments } : {}) }
}
export function approvalInput(value: unknown): ResolveAgentApprovalRequest {
  const v = object(value, ['decision', 'expectedArgumentsHash'])
  if ((v.decision !== 'approved' && v.decision !== 'rejected') || typeof v.expectedArgumentsHash !== 'string' || !/^[0-9a-f]{64}$/.test(v.expectedArgumentsHash)) throw new AgentCoreError('INVALID_INPUT')
  return { decision: v.decision, expectedArgumentsHash: v.expectedArgumentsHash }
}
export function emptyInput(value: unknown): void { object(value, []) }
export function pageQuery(url: URL, kind: 'sessions' | 'items' | 'snapshot' | 'events') {
  const allowed = kind === 'snapshot' ? ['limit'] : ['limit', 'cursor']
  for (const [key] of url.searchParams) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new AgentCoreError('INVALID_INPUT')
  const raw = url.searchParams.get('limit')
  if (raw !== null && !/^[1-9][0-9]{0,2}$/.test(raw)) throw new AgentCoreError('INVALID_INPUT')
  const limit = raw === null ? 50 : Number(raw)
  if (limit > 100) throw new AgentCoreError('INVALID_INPUT')
  const value = url.searchParams.get('cursor')
  const cursor = value === null ? undefined : kind === 'sessions' ? uuid(value) : agentCoreDecimal(value)
  return { limit, cursor }
}
export function eventCursor(sessionId: string, query: string | undefined, header: string | null) {
  let fromHeader: string | undefined
  if (header !== null) {
    if (header.length > 56) throw new AgentCoreError('INVALID_INPUT')
    const parts = header.split(':')
    if (parts.length !== 2 || uuid(parts[0]) !== sessionId) throw new AgentCoreError('INVALID_INPUT')
    fromHeader = agentCoreDecimal(parts[1])
  }
  if (query !== undefined && fromHeader !== undefined && query !== fromHeader) throw new AgentCoreError('CONFLICT')
  return agentCoreDecimal(query ?? fromHeader ?? '0')
}
/** Read bytes before JSON parsing; content-length is checked but never trusted as the only bound. */
export async function boundedBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AgentCoreError('INVALID_INPUT')
  const length = request.headers.get('content-length')
  if (length !== null && (!/^(0|[1-9][0-9]{0,5})$/.test(length) || Number(length) > 40000)) throw new AgentCoreError('INVALID_INPUT')
  if (!request.body) throw new AgentCoreError('INVALID_INPUT')
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []; let size = 0
  let interrupted = false
  const abort = () => { interrupted = true; void reader.cancel().catch(() => {}) }
  const timeout = setTimeout(abort, 5000)
  request.signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      if (request.signal.aborted) throw new AgentCoreError('INVALID_INPUT')
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 40000) { await reader.cancel(); throw new AgentCoreError('INVALID_INPUT') }
      parts.push(part.value)
    }
    if (interrupted || request.signal.aborted) throw new AgentCoreError('INVALID_INPUT')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as unknown
  } catch { throw new AgentCoreError('INVALID_INPUT') }
  finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); reader.releaseLock() }
}
export function definitionBudget(value: unknown): AgentDefinitionBudgetPolicy {
  const v = object(value, ['maxModelCalls', 'maxToolCalls', 'maxMediaJobs', 'maxMediaOutputs', 'maxInputTokens', 'maxOutputTokens', 'maxEstimatedCost', 'maxConcurrentMediaJobs', 'timeoutMs'])
  let cost: AgentBudgetDTO['maxEstimatedCost'] = null
  if (v.maxEstimatedCost !== null) {
    const c = object(v.maxEstimatedCost, ['amount', 'currency', 'pricingReference'])
    if (typeof c.amount !== 'string' || !/^(0|[1-9][0-9]{0,20})(\.[0-9]{1,9})?$/.test(c.amount)
      || typeof c.currency !== 'string' || !/^[A-Z]{3}$/.test(c.currency)
      || typeof c.pricingReference !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(c.pricingReference)) throw new AgentCoreError('INVALID_INPUT')
    cost = { amount: c.amount, currency: c.currency, pricingReference: c.pricingReference }
  }
  return { maxModelCalls: integer(v.maxModelCalls, 1, 1000), maxToolCalls: integer(v.maxToolCalls, 0, 1000),
    maxMediaJobs: integer(v.maxMediaJobs, 0, 1000), maxMediaOutputs: integer(v.maxMediaOutputs, 0, 1000),
    maxInputTokens: agentCoreDecimal(storageString(v.maxInputTokens, 19)), maxOutputTokens: agentCoreDecimal(storageString(v.maxOutputTokens, 19)),
    maxEstimatedCost: cost, maxConcurrentMediaJobs: integer(v.maxConcurrentMediaJobs, 0, 1000), timeoutMs: integer(v.timeoutMs, 1, 300000) }
}
export function modelPolicy(value: unknown) {
  const v = object(value, ['modelConfigId', 'modelRevisionId'])
  return { modelConfigId: uuid(v.modelConfigId), modelRevisionId: uuid(v.modelRevisionId) }
}
