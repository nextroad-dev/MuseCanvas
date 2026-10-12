import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  applyCanvasOps, parseCanvasAgentMessageRequest, parseCanvasAgentEditMetadata,
  type CanvasAgentEditMetadata, type CanvasScene,
  type AgentMessageDto, type CanvasAgentPendingJobDto, type CanvasAgentSettingsDto, type CanvasAgentToolCallDto,
  type CanvasAgentUsageDto, type CanvasOp, type UpdateCanvasAgentSettingsRequest,
} from '@musecanvas/contracts'
import type { JsonObject, JsonValue } from '@musecanvas/contracts'
import { validateCanvasReferences } from './canvas-documents'

/** Every multi-statement function requires an already-open, SHORT transaction on this client.
 * Commit before LLM/generation/network calls. Never pass a Pool or hold this transaction while streaming.
 * All identifiers/inputs are server-owned or validated at the API boundary, not client pending snapshots. */
export type CanvasAgentClient = pg.PoolClient
export interface CanvasAgentScope { actorId: string; canvasId: string; sessionId: string }
export interface CanvasAgentSession {
  id: string; canvasId: string; createdBy: string; requireConfirmation: boolean; nextSeq: number
  autoContinuationCount: number; runningTurnId: string | null; runningLeaseToken: string | null
  runningLeaseExpiresAt: string | null; createdAt: string; updatedAt: string
}
export type CanvasAgentTurnStatus = 'running' | 'completed' | 'failed' | 'canceled' | 'expired'
export interface CanvasAgentTurn {
  id: string; sessionId: string; messageId: string; requestSnapshot?: JsonValue | null
  requestDigest: string; status: CanvasAgentTurnStatus
  leaseToken: string; leaseExpiresAt: string; timeoutMs: number; startedAt: string
  completedAt: string | null; errorCode: string | null
  sceneCommitOps?: CanvasOp[] | null; sceneCommitRevision?: number | null; sceneCommitAt?: string | null
}
export interface CanvasAgentStoredMessage extends AgentMessageDto {
  sessionId: string; turnId: string | null; contentBlocks: JsonValue[]
}
export interface CanvasAgentMessageInput {
  id?: string; role: AgentMessageDto['role']; content: string; toolCalls?: CanvasAgentToolCallDto[]
  contentBlocks?: JsonValue[]; ops?: CanvasOp[]; usage?: CanvasAgentUsageDto
}
export interface CanvasAgentPendingJob extends Omit<CanvasAgentPendingJobDto, 'editMetadata'> {
  sessionId: string; canvasId: string; createdBy: string; turnId: string; baseRevision: number
  nodeId: string; edgeId: string; idempotencyKey: string; requestDigest: string; modelConfigDigest: string
  leaseToken: string | null; leaseExpiresAt: string | null; ops: CanvasOp[]; updatedAt: string
  requestVersion?: number
  editMetadata?: CanvasAgentEditMetadata | null
  normalizedRequest?: JsonObject | null
  normalizedInputs?: Array<{ uploadId?: string; assetId?: string; role: string; position: number }>
}
export type CanvasAgentTurnClaim =
  | { status: 'claimed' | 'replay'; turn: CanvasAgentTurn }
  | { status: 'not_found' | 'busy' | 'conflict' }
export interface CanvasAgentTurnInput {
  /** SHA-256 of the complete validated request (including confirmation/baseRevision), computed by the
   * server with canvasAgentRequestDigest. Never accept a digest claimed by the client. */
  messageId: string; requestDigest: string; timeoutMs: number; requireConfirmation?: boolean
  requestSnapshot?: JsonValue | null
}
export interface CanvasAgentLease { turnId: string; leaseToken: string }
export type CanvasAgentPendingClaim =
  | { status: 'claimed' | 'replay' | 'busy' | 'rejected' | 'expired'; pending: CanvasAgentPendingJob }
  | { status: 'not_found' }

function entity<T>(raw: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    value instanceof Date ? value.toISOString() : value,
  ])) as T
}
function message(raw: Record<string, unknown>): CanvasAgentStoredMessage {
  const mapped = entity<CanvasAgentStoredMessage & { inputTokens: number | null; outputTokens: number | null }>(raw)
  const { inputTokens, outputTokens, ...rest } = mapped
  return { ...rest, ...(inputTokens === null ? {} : { usage: { inputTokens, outputTokens: outputTokens! } }) }
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid canvas agent numeric bound')
  return value
}
function digest(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Expected SHA-256 request digest')
  return value
}
/** Canonical key ordering; arrays (including provider content blocks) retain their original order. */
export function canvasAgentRequestDigest(value: JsonValue): string {
  function canonical(item: JsonValue): string {
    if (item === null || typeof item !== 'object') return JSON.stringify(item)
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key]!)}`).join(',')}}`
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}
/** One immutable normalized payload for submission, recovery and SQL attachment checks.
 * An actor-owned idempotency key is predictable and is NOT proof of request identity. */
export function canvasAgentGenerationRequest(pending: CanvasAgentPendingJob | Pick<CanvasAgentPendingJob, 'kind' | 'modelId' | 'prompt' | 'parameters' | 'sourceAssetId'>) {
  if ('requestVersion' in pending && pending.requestVersion && pending.requestVersion >= 2 && 'normalizedRequest' in pending && pending.normalizedRequest) {
    return pending.normalizedRequest as {
      modelId: string
      prompt: string
      parameters: JsonObject
      mode: 'text_to_image' | 'image_to_image' | 'inpaint' | 'text_to_video' | 'image_to_video'
      inputs: Array<{ uploadId?: string; assetId?: string; role: string; position: number }>
    }
  }
  return { modelId: pending.modelId, prompt: pending.prompt, parameters: pending.parameters,
    mode: pending.kind === 'image' ? 'text_to_image' as const : 'image_to_video' as const,
    inputs: pending.kind === 'video' ? [{ assetId: pending.sourceAssetId!, role: 'first_frame', position: 0 }] : [] }
}
export function canvasAgentGenerationJobMatches(pending: CanvasAgentPendingJob, job: Record<string, unknown>): boolean {
  if (job.media_kind !== pending.kind || job.model_id !== pending.modelId) return false
  try {
    const payload = typeof job.normalized_request === 'string' ? JSON.parse(job.normalized_request) : job.normalized_request
    return canvasAgentRequestDigest(payload) === canvasAgentRequestDigest(canvasAgentGenerationRequest(pending) as JsonObject)
  } catch { return false }
}
/** Namespaced deterministic UUIDs, including tool call IDs that are only provider-local. */
export function canvasAgentPendingIdentity(canvasId: string, toolCallId: string): {
  id: string; nodeId: string; edgeId: string; idempotencyKey: string
} {
  if (!toolCallId || toolCallId.length > 512) throw new Error('Invalid tool call ID')
  function uuid(kind: string): string {
    const chars = createHash('sha256').update(JSON.stringify(['musecanvas-agent-v1', canvasId.toLowerCase(), toolCallId, kind])).digest('hex').slice(0, 32).split('')
    chars[12] = '5'; chars[16] = ((parseInt(chars[16]!, 16) & 3) | 8).toString(16)
    const hex = chars.join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return { id: uuid('pending'), nodeId: uuid('node'), edgeId: uuid('edge'), idempotencyKey: `canvas:${canvasId.toLowerCase()}:${toolCallId}` }
}
const joins = `JOIN canvas_documents c ON c.id = s.canvas_id AND c.created_by = s.created_by AND c.deleted_at IS NULL`
const owner = `s.created_by = $1 AND s.canvas_id = $2 AND s.id = $3 AND c.created_by = $1`
const pendingJoins = `JOIN canvas_agent_sessions s ON s.id = p.session_id AND s.canvas_id = p.canvas_id AND s.created_by = p.created_by ${joins}`
const args = (scope: CanvasAgentScope) => [scope.actorId, scope.canvasId, scope.sessionId]
async function lockSession(client: CanvasAgentClient, scope: CanvasAgentScope): Promise<CanvasAgentSession | null> {
  const res = await client.query(`SELECT s.* FROM canvas_agent_sessions s ${joins} WHERE ${owner} FOR UPDATE OF s`, args(scope))
  return res.rows[0] ? entity<CanvasAgentSession>(res.rows[0]) : null
}
/** Read-only session lookup for recovery; never creates a session on GET. */
export async function findCanvasAgentSessionForCanvas(
  client: CanvasAgentClient, input: { actorId: string; canvasId: string },
): Promise<CanvasAgentSession | null> {
  const res = await client.query(`SELECT s.* FROM canvas_agent_sessions s ${joins}
    WHERE s.created_by = $1 AND s.canvas_id = $2 AND c.created_by = $1`, [input.actorId, input.canvasId])
  return res.rows[0] ? entity<CanvasAgentSession>(res.rows[0]) : null
}
export async function getOrCreateCanvasAgentSession(
  client: CanvasAgentClient, input: { actorId: string; canvasId: string },
): Promise<CanvasAgentSession | null> {
  await client.query(`INSERT INTO canvas_agent_sessions(canvas_id, created_by)
    SELECT c.id, c.created_by FROM canvas_documents c WHERE c.id = $2 AND c.created_by = $1 AND c.deleted_at IS NULL
    ON CONFLICT(canvas_id) DO NOTHING`, [input.actorId, input.canvasId])
  const res = await client.query(`SELECT s.* FROM canvas_agent_sessions s ${joins}
    WHERE s.created_by = $1 AND s.canvas_id = $2 AND c.created_by = $1`, [input.actorId, input.canvasId])
  return res.rows[0] ? entity<CanvasAgentSession>(res.rows[0]) : null
}
export async function getCanvasAgentSession(client: CanvasAgentClient, scope: CanvasAgentScope): Promise<CanvasAgentSession | null> {
  const res = await client.query(`SELECT s.* FROM canvas_agent_sessions s ${joins} WHERE ${owner}`, args(scope))
  return res.rows[0] ? entity<CanvasAgentSession>(res.rows[0]) : null
}
export async function getCanvasAgentTurn(
  client: CanvasAgentClient, scope: CanvasAgentScope, messageId: string,
): Promise<CanvasAgentTurn | null> {
  const res = await client.query(`SELECT t.* FROM canvas_agent_turns t JOIN canvas_agent_sessions s ON s.id = t.session_id
    ${joins} WHERE ${owner} AND t.message_id = $4`, [...args(scope), messageId])
  return res.rows[0] ? entity<CanvasAgentTurn>(res.rows[0]) : null
}
/** Mutation order shared by apply and confirmation: session → turn → canvas → pending.
 * Read the turn AFTER the session lock, including replay markers. */
export async function lockCanvasAgentTurn(
  client: CanvasAgentClient, scope: CanvasAgentScope, turnId: string,
): Promise<{ session: CanvasAgentSession; turn: CanvasAgentTurn; canvas: { revision: number; scene: CanvasScene; cover_asset_id: string | null } } | null> {
  const session = await lockSession(client, scope)
  if (!session) return null
  const turnRes = await client.query(`SELECT t.* FROM canvas_agent_turns t JOIN canvas_agent_sessions s ON s.id = t.session_id
    ${joins} WHERE ${owner} AND t.id = $4 FOR UPDATE OF t`, [...args(scope), turnId])
  if (!turnRes.rows[0]) return null
  const canvasRes = await client.query(`SELECT revision, scene, cover_asset_id FROM canvas_documents
    WHERE id = $2 AND created_by = $1 AND deleted_at IS NULL FOR UPDATE`, [scope.actorId, scope.canvasId])
  if (!canvasRes.rows[0]) return null
  return { session, turn: entity<CanvasAgentTurn>(turnRes.rows[0]), canvas: canvasRes.rows[0] }
}
export async function getCanvasAgentTurnById(
  client: CanvasAgentClient, scope: CanvasAgentScope, turnId: string,
): Promise<CanvasAgentTurn | null> {
  const res = await client.query(`SELECT t.* FROM canvas_agent_turns t JOIN canvas_agent_sessions s ON s.id = t.session_id
    ${joins} WHERE ${owner} AND t.id = $4`, [...args(scope), turnId])
  return res.rows[0] ? entity<CanvasAgentTurn>(res.rows[0]) : null
}
/** Old digests omitted sceneCommitMode. Compatibility is limited to snapshot-null legacy
 * requests with the exact old shape; no digest/row/key is rewritten. */
export function canvasAgentTurnRequestMatches(turn: CanvasAgentTurn, input: CanvasAgentTurnInput): boolean {
  if (turn.requestDigest === input.requestDigest) return true
  if (turn.requestSnapshot != null || !input.requestSnapshot) return false
  const parsed = parseCanvasAgentMessageRequest(input.requestSnapshot)
  if (!parsed.success || parsed.data.sceneCommitMode !== 'client-managed' || ('context' in parsed.data && parsed.data.context !== undefined)) return false
  if (canvasAgentRequestDigest(parsed.data as unknown as JsonObject) !== input.requestDigest) return false
  const { sceneCommitMode: _mode, ...legacy } = parsed.data
  return canvasAgentRequestDigest(legacy as unknown as JsonObject) === turn.requestDigest
}
export async function claimCanvasAgentTurn(
  client: CanvasAgentClient, scope: CanvasAgentScope, input: CanvasAgentTurnInput,
): Promise<CanvasAgentTurnClaim> {
  bounded(input.timeoutMs, 1000, 300000); digest(input.requestDigest)
  if (!await lockSession(client, scope)) return { status: 'not_found' }
  const prior = await getCanvasAgentTurn(client, scope, input.messageId)
  if (prior && !canvasAgentTurnRequestMatches(prior, input)) return { status: 'conflict' }
  if (prior && prior.status !== 'running') return { status: 'replay', turn: prior }
  const token = randomUUID(), turnId = prior?.id ?? randomUUID()
  // Session CAS serializes distinct requests too; database clock decides expiry, not API process clocks.
  const slot = await client.query(`UPDATE canvas_agent_sessions s SET running_turn_id = $4,
    running_lease_token = $5, running_lease_expires_at = now() + $6 * interval '1 millisecond',
    require_confirmation = COALESCE($7, s.require_confirmation), updated_at = now()
    FROM canvas_documents c WHERE c.id = s.canvas_id AND c.created_by = s.created_by AND c.deleted_at IS NULL
    AND ${owner} AND (s.running_turn_id IS NULL OR s.running_lease_expires_at <= now()) RETURNING s.*`,
  [...args(scope), turnId, token, input.timeoutMs, input.requireConfirmation ?? null])
  if (!slot.rows[0]) return { status: 'busy' }
  await client.query(`UPDATE canvas_agent_turns t SET status = 'expired', completed_at = now(), error_code = 'CANVAS_AGENT_TIMEOUT'
    FROM canvas_agent_sessions s ${joins} WHERE ${owner} AND t.session_id = s.id
    AND t.id <> $4 AND t.status = 'running' AND t.lease_expires_at <= now()`, [...args(scope), turnId])
  const res = await client.query(`INSERT INTO canvas_agent_turns(id, session_id, message_id, request_digest, status, lease_token, lease_expires_at, timeout_ms, request_snapshot)
    SELECT $4, s.id, $5, $6, 'running', s.running_lease_token, s.running_lease_expires_at, $7, $8::jsonb
    FROM canvas_agent_sessions s ${joins} WHERE ${owner} AND s.running_turn_id = $4
    ON CONFLICT(session_id, message_id) DO UPDATE SET lease_token = EXCLUDED.lease_token,
      lease_expires_at = EXCLUDED.lease_expires_at, timeout_ms = EXCLUDED.timeout_ms, started_at = now()
    WHERE canvas_agent_turns.status = 'running' AND canvas_agent_turns.request_digest = EXCLUDED.request_digest
    RETURNING *`, [...args(scope), turnId, input.messageId, prior?.requestDigest ?? input.requestDigest, input.timeoutMs, input.requestSnapshot == null ? null : JSON.stringify(input.requestSnapshot)])
  if (!res.rows[0]) throw new Error('Canvas agent turn CAS invariant failed; roll back transaction')
  return { status: 'claimed', turn: entity<CanvasAgentTurn>(res.rows[0]) }
}
const activeLease = `s.running_turn_id = $4 AND s.running_lease_token = $5 AND s.running_lease_expires_at > now()`
/** Sequence allocation and INSERT share one statement; invalid owner/lease never consumes a sequence.
 * Optional lease is for server-side imports only; runtime turn writes should always supply it. */
export async function appendCanvasAgentMessage(
  client: CanvasAgentClient, scope: CanvasAgentScope, input: CanvasAgentMessageInput, lease?: CanvasAgentLease,
): Promise<CanvasAgentStoredMessage | null> {
  const res = await client.query(`WITH allocated AS (
    UPDATE canvas_agent_sessions s SET next_seq = s.next_seq + 1, updated_at = now()
    FROM canvas_documents c WHERE c.id = s.canvas_id AND c.created_by = s.created_by AND c.deleted_at IS NULL AND ${owner}
    AND ($4::uuid IS NULL OR (${activeLease})) RETURNING s.id, s.next_seq - 1 AS seq
  ) INSERT INTO canvas_agent_messages(id, session_id, turn_id, seq, role, content, tool_calls, content_blocks, ops, input_tokens, output_tokens)
    SELECT $6, id, $4, seq, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13 FROM allocated RETURNING *`,
  [...args(scope), lease?.turnId ?? null, lease?.leaseToken ?? null, input.id ?? randomUUID(), input.role, input.content,
    JSON.stringify(input.toolCalls ?? []), JSON.stringify(input.contentBlocks ?? []), JSON.stringify(input.ops ?? []),
    input.usage?.inputTokens ?? null, input.usage?.outputTokens ?? null])
  return res.rows[0] ? message(res.rows[0]) : null
}
/** Retries of the same running turn reuse its original user message, rather than appending it again. */
export async function beginCanvasAgentTurn(
  client: CanvasAgentClient, scope: CanvasAgentScope, input: CanvasAgentTurnInput, userMessage: CanvasAgentMessageInput,
): Promise<CanvasAgentTurnClaim> {
  const result = await claimCanvasAgentTurn(client, scope, input)
  if (result.status === 'claimed') {
    const exists = await client.query(`SELECT m.id FROM canvas_agent_messages m JOIN canvas_agent_sessions s ON s.id = m.session_id
      ${joins} WHERE ${owner} AND m.id = $4`, [...args(scope), input.messageId])
    if (!exists.rows[0]) {
      const appended = await appendCanvasAgentMessage(client, scope, { ...userMessage, id: input.messageId },
        { turnId: result.turn.id, leaseToken: result.turn.leaseToken })
      if (!appended) throw new Error('Lost canvas agent lease; roll back transaction')
    }
  }
  return result
}
export async function releaseCanvasAgentTurn(
  client: CanvasAgentClient, scope: CanvasAgentScope, lease: CanvasAgentLease,
  status: Exclude<CanvasAgentTurnStatus, 'running'>, errorCode: string | null = null,
): Promise<boolean> {
  const res = await client.query(`WITH released AS (
    UPDATE canvas_agent_sessions s SET running_turn_id = NULL, running_lease_token = NULL, running_lease_expires_at = NULL, updated_at = now()
    FROM canvas_documents c WHERE c.id = s.canvas_id AND c.created_by = s.created_by AND c.deleted_at IS NULL
    AND ${owner} AND s.running_turn_id = $4 AND s.running_lease_token = $5 RETURNING s.id
  ) UPDATE canvas_agent_turns t SET status = $6, completed_at = now(), error_code = $7
    FROM released r WHERE t.session_id = r.id AND t.id = $4 AND t.lease_token = $5 AND t.status = 'running' RETURNING t.id`,
  [...args(scope), lease.turnId, lease.leaseToken, status, errorCode])
  return !!res.rows[0]
}
/** Output append + release are atomic in the caller's transaction; never send a successful SSE done before commit. */
export async function finishCanvasAgentTurn(
  client: CanvasAgentClient, scope: CanvasAgentScope, lease: CanvasAgentLease, output: CanvasAgentMessageInput,
): Promise<CanvasAgentStoredMessage | null> {
  const appended = await appendCanvasAgentMessage(client, scope, output, lease)
  if (!appended) return null
  if (!await releaseCanvasAgentTurn(client, scope, lease, 'completed')) throw new Error('Lost canvas agent lease; roll back transaction')
  return appended
}
export async function readCanvasAgentMessages(
  client: CanvasAgentClient, scope: CanvasAgentScope, input: { afterSeq?: number; beforeSeq?: number; limit?: number } = {},
): Promise<{ messages: CanvasAgentStoredMessage[]; nextAfterSeq: number | null; nextBeforeSeq?: number | null }> {
  const limit = bounded(input.limit ?? 100, 1, 200)
  if (input.beforeSeq !== undefined) {
    const before = bounded(input.beforeSeq, 1, 2147483647)
    const res = await client.query(`SELECT m.* FROM canvas_agent_messages m JOIN canvas_agent_sessions s ON s.id = m.session_id
      ${joins} WHERE ${owner} AND m.seq < $4 ORDER BY m.seq DESC LIMIT $5`, [...args(scope), before, limit + 1])
    const rows = res.rows.slice(0, limit).reverse()
    const messages = rows.map(message)
    return { messages, nextAfterSeq: null, nextBeforeSeq: res.rows.length > limit && messages[0] ? messages[0].seq : null }
  }
  const after = bounded(input.afterSeq ?? 0, 0, 2147483647)
  const res = await client.query(`SELECT m.* FROM canvas_agent_messages m JOIN canvas_agent_sessions s ON s.id = m.session_id
    ${joins} WHERE ${owner} AND m.seq > $4 ORDER BY m.seq ASC LIMIT $5`, [...args(scope), after, limit + 1])
  const messages = res.rows.slice(0, limit).map(message)
  return { messages, nextAfterSeq: res.rows.length > limit && messages.at(-1) ? messages.at(-1)!.seq : null }
}
/** Page one requested turn independently of the bounded provider-context window.
 * Callers collect all pages before replaying, so tool pairs are never truncated. */
export async function readCanvasAgentTurnMessages(
  client: CanvasAgentClient, scope: CanvasAgentScope, turnId: string, input: { afterSeq?: number; limit?: number } = {},
): Promise<{ messages: CanvasAgentStoredMessage[]; nextAfterSeq: number | null }> {
  const after = bounded(input.afterSeq ?? 0, 0, 2147483647), limit = bounded(input.limit ?? 100, 1, 200)
  const res = await client.query(`SELECT m.* FROM canvas_agent_messages m JOIN canvas_agent_sessions s ON s.id = m.session_id
    ${joins} WHERE ${owner} AND m.turn_id = $4 AND m.seq > $5 ORDER BY m.seq ASC LIMIT $6`, [...args(scope), turnId, after, limit + 1])
  const messages = res.rows.slice(0, limit).map(message)
  return { messages, nextAfterSeq: res.rows.length > limit ? messages.at(-1)!.seq : null }
}
export async function getCanvasAgentPendingJob(
  client: CanvasAgentClient, scope: CanvasAgentScope, pendingId: string,
): Promise<CanvasAgentPendingJob | null> {
  const res = await client.query(`SELECT p.* FROM canvas_agent_pending_jobs p ${pendingJoins} WHERE ${owner} AND p.id = $4`, [...args(scope), pendingId])
  return res.rows[0] ? entity<CanvasAgentPendingJob>(res.rows[0]) : null
}
export async function readCanvasAgentTurnPendingJobs(
  client: CanvasAgentClient, scope: CanvasAgentScope, turnId: string,
): Promise<CanvasAgentPendingJob[]> {
  const res = await client.query(`SELECT p.* FROM canvas_agent_pending_jobs p ${pendingJoins}
    WHERE ${owner} AND p.turn_id = $4 ORDER BY p.id`, [...args(scope), turnId])
  return res.rows.map(row => entity<CanvasAgentPendingJob>(row))
}
export async function readCanvasAgentPendingJobs(
  client: CanvasAgentClient, scope: CanvasAgentScope, input: { afterId?: string; limit?: number } = {},
): Promise<{ pendingJobs: CanvasAgentPendingJob[]; nextAfterId: string | null }> {
  const limit = bounded(input.limit ?? 100, 1, 200)
  const res = await client.query(`SELECT p.* FROM canvas_agent_pending_jobs p ${pendingJoins}
    WHERE ${owner} AND ($4::uuid IS NULL OR p.id > $4) ORDER BY p.id ASC LIMIT $5`, [...args(scope), input.afterId ?? null, limit + 1])
  const pendingJobs = res.rows.slice(0, limit).map(row => entity<CanvasAgentPendingJob>(row))
  return { pendingJobs, nextAfterId: res.rows.length > limit ? pendingJobs.at(-1)!.id : null }
}
export interface CreateCanvasAgentPendingInput {
  toolCallId: string; kind: 'image' | 'video'; prompt: string; modelId: string; parameters: JsonObject
  sourceNodeId: string | null; sourceAssetId: string | null; baseRevision: number; expiresAt: string; modelConfigDigest: string
  /** Stable placeholder ops, WITHOUT jobId. Completion injects the returned jobId into the stable media node. */
  ops: CanvasOp[]
  requestVersion?: number
  editMetadata?: CanvasAgentEditMetadata | null
  normalizedRequest?: JsonObject | null
  normalizedInputs?: Array<{ uploadId?: string; assetId?: string; role: string; position: number }>
}
export async function createCanvasAgentPendingJob(
  client: CanvasAgentClient, scope: CanvasAgentScope, lease: CanvasAgentLease, input: CreateCanvasAgentPendingInput,
): Promise<{ status: 'created' | 'replay'; pending: CanvasAgentPendingJob } | { status: 'not_found' | 'conflict' }> {
  digest(input.modelConfigDigest)
  if (input.editMetadata && !parseCanvasAgentEditMetadata(input.editMetadata).success) throw new Error('Invalid prepared edit metadata')
  const ids = canvasAgentPendingIdentity(scope.canvasId, input.toolCallId)
  const snapshotDigest = canvasAgentRequestDigest({ ...input, actorId: scope.actorId, canvasId: scope.canvasId,
    sessionId: scope.sessionId, turnId: lease.turnId, ...ids } as unknown as JsonObject)
  const prior = await getCanvasAgentPendingJob(client, scope, ids.id)
  if (prior) return prior.requestDigest === snapshotDigest ? { status: 'replay', pending: prior } : { status: 'conflict' }
  // Serialize against another tool write, finish, or expired-turn takeover.
  if (!await lockSession(client, scope)) return { status: 'not_found' }
  const node = input.ops.find(op => op.type === 'add_node' && op.node.id === ids.nodeId)
  if (!node || node.type !== 'add_node' || node.node.type !== input.kind || 'jobId' in node.node.data) throw new Error('Pending ops must contain the stable unsubmitted media node')
  const requestVersion = input.requestVersion ?? 1
  const normalizedRequest = input.normalizedRequest ? JSON.stringify(input.normalizedRequest) : null
  const normalizedInputs = JSON.stringify(input.normalizedInputs ?? [])
  const res = await client.query(`INSERT INTO canvas_agent_pending_jobs(id, session_id, canvas_id, created_by, turn_id,
    tool_call_id, kind, prompt, model_id, parameters, source_node_id, source_asset_id, base_revision, node_id, edge_id,
    idempotency_key, request_digest, expires_at, ops, model_config_digest, request_version, normalized_request, normalized_inputs, edit_metadata)
    SELECT $6, s.id, s.canvas_id, s.created_by, $4, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, $22, $23::jsonb, $24::jsonb, $25::jsonb
    FROM canvas_agent_sessions s ${joins} WHERE ${owner} AND ${activeLease}
    ON CONFLICT(canvas_id, tool_call_id) DO NOTHING RETURNING *`,
  [...args(scope), lease.turnId, lease.leaseToken, ids.id, input.toolCallId, input.kind, input.prompt, input.modelId,
    JSON.stringify(input.parameters), input.sourceNodeId, input.sourceAssetId, input.baseRevision, ids.nodeId, ids.edgeId,
    ids.idempotencyKey, snapshotDigest, input.expiresAt, JSON.stringify(input.ops), input.modelConfigDigest,
    requestVersion, normalizedRequest, normalizedInputs, input.editMetadata == null ? null : JSON.stringify(input.editMetadata)])
  if (res.rows[0]) return { status: 'created', pending: entity<CanvasAgentPendingJob>(res.rows[0]) }
  const existing = await getCanvasAgentPendingJob(client, scope, ids.id)
  if (existing) return existing.requestDigest === snapshotDigest ? { status: 'replay', pending: existing } : { status: 'conflict' }
  return { status: 'not_found' }
}
/** Commit the claim BEFORE calling createGenerationJob. An expired submitting claim is recoverable
 * even after expiresAt: the generation might already exist, so use ONLY persisted inputs + idempotencyKey. */
export async function claimCanvasAgentPendingJob(
  client: CanvasAgentClient, scope: CanvasAgentScope, pendingId: string, timeoutMs: number,
): Promise<CanvasAgentPendingClaim> {
  bounded(timeoutMs, 1000, 300000)
  const beforeLock = await getCanvasAgentPendingJob(client, scope, pendingId)
  if (!beforeLock || !await lockCanvasAgentTurn(client, scope, beforeLock.turnId)) return { status: 'not_found' }
  await client.query(`UPDATE canvas_agent_pending_jobs p SET status = 'expired', updated_at = now()
    FROM canvas_agent_sessions s ${joins} WHERE ${owner} AND p.session_id = s.id AND p.created_by = $1 AND p.canvas_id = $2
    AND p.id = $4 AND p.status = 'pending' AND p.expires_at <= now()`, [...args(scope), pendingId])
  const res = await client.query(`UPDATE canvas_agent_pending_jobs p SET status = 'submitting', lease_token = $5,
    lease_expires_at = now() + $6 * interval '1 millisecond', updated_at = now()
    FROM canvas_agent_sessions s ${joins} WHERE ${owner} AND p.session_id = s.id AND p.created_by = $1 AND p.canvas_id = $2
    AND p.id = $4 AND ((p.status = 'pending' AND p.expires_at > now())
      OR (p.status = 'submitting' AND p.lease_expires_at <= now())) RETURNING p.*`,
  [...args(scope), pendingId, randomUUID(), timeoutMs])
  if (res.rows[0]) return { status: 'claimed', pending: entity<CanvasAgentPendingJob>(res.rows[0]) }
  const pending = await getCanvasAgentPendingJob(client, scope, pendingId)
  if (!pending) return { status: 'not_found' }
  return { status: pending.status === 'submitted' ? 'replay' : pending.status === 'rejected' ? 'rejected'
    : pending.status === 'expired' ? 'expired' : 'busy', pending }
}
/** A successful external create followed by a crash is repaired by re-claim + same generation key.
 * Stale tokens cannot attach results; the next holder recovers that same job. No reset-to-pending API. */
export async function completeCanvasAgentPendingJob(
  client: CanvasAgentClient, scope: CanvasAgentScope, input: { pendingId: string; leaseToken: string; jobId: string },
): Promise<{ status: 'completed' | 'replay'; pending: CanvasAgentPendingJob } | { status: 'not_found' | 'conflict' }> {
  const beforeLock = await getCanvasAgentPendingJob(client, scope, input.pendingId)
  if (!beforeLock || !await lockCanvasAgentTurn(client, scope, beforeLock.turnId)) return { status: 'not_found' }
  const pending = await getCanvasAgentPendingJob(client, scope, input.pendingId)
  if (!pending) return { status: 'not_found' }
  const job = (await client.query(`SELECT j.* FROM generation_jobs j JOIN canvas_agent_pending_jobs p ON p.id = $4
    ${pendingJoins} WHERE ${owner} AND j.id = $5 AND j.created_by = $1
    AND j.idempotency_key = p.idempotency_key AND j.deleted_at IS NULL`, [...args(scope), input.pendingId, input.jobId])).rows[0]
  if (!job || !canvasAgentGenerationJobMatches(pending, job)) return { status: 'conflict' }
  if (pending.status === 'submitted') return pending.jobId === input.jobId ? { status: 'replay', pending } : { status: 'conflict' }
  const ops = pending.ops.map(op => op.type === 'add_node' && op.node.id === pending.nodeId
    ? { ...op, node: { ...op.node, data: { ...op.node.data, jobId: input.jobId } } } : op)
  const res = await client.query(`UPDATE canvas_agent_pending_jobs p SET status = 'submitted', job_id = $6,
    ops = $7::jsonb, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    FROM canvas_agent_sessions s ${joins}, generation_jobs j
    WHERE ${owner} AND p.session_id = s.id AND p.created_by = $1 AND p.canvas_id = $2 AND p.id = $4
    AND p.status = 'submitting' AND p.lease_token = $5 AND p.lease_expires_at > now()
    AND j.id = $6 AND j.created_by = $1 AND j.idempotency_key = p.idempotency_key AND j.deleted_at IS NULL
    AND j.media_kind = p.kind AND j.model_id = p.model_id AND j.normalized_request = $8::jsonb RETURNING p.*`,
  [...args(scope), input.pendingId, input.leaseToken, input.jobId, JSON.stringify(ops), JSON.stringify(canvasAgentGenerationRequest(pending))])
  if (res.rows[0]) return { status: 'completed', pending: entity<CanvasAgentPendingJob>(res.rows[0]) }
  const replay = await getCanvasAgentPendingJob(client, scope, input.pendingId)
  if (replay?.status === 'submitted' && replay.jobId === input.jobId) return { status: 'replay', pending: replay }
  return { status: 'conflict' }
}
export async function rejectCanvasAgentPendingJob(
  client: CanvasAgentClient, scope: CanvasAgentScope, pendingId: string,
): Promise<CanvasAgentPendingClaim> {
  const beforeLock = await getCanvasAgentPendingJob(client, scope, pendingId)
  if (!beforeLock || !await lockCanvasAgentTurn(client, scope, beforeLock.turnId)) return { status: 'not_found' }
  const res = await client.query(`UPDATE canvas_agent_pending_jobs p
    SET status = CASE WHEN p.expires_at <= now() THEN 'expired' ELSE 'rejected' END, updated_at = now()
    FROM canvas_agent_sessions s ${joins} WHERE ${owner} AND p.session_id = s.id AND p.created_by = $1 AND p.canvas_id = $2
    AND p.id = $4 AND p.status = 'pending' RETURNING p.*`, [...args(scope), pendingId])
  const pending = res.rows[0] ? entity<CanvasAgentPendingJob>(res.rows[0]) : await getCanvasAgentPendingJob(client, scope, pendingId)
  if (!pending) return { status: 'not_found' }
  return { status: pending.status === 'submitted' ? 'replay' : pending.status === 'rejected' ? 'rejected'
    : pending.status === 'expired' ? 'expired' : 'busy', pending }
}
/** Bound lookup only. API MUST verify real job terminal status and any asset ownership/job linkage. */
export async function findCanvasAgentPendingByJob(
  client: CanvasAgentClient, scope: CanvasAgentScope, jobId: string,
): Promise<CanvasAgentPendingJob | null> {
  const res = await client.query(`SELECT p.* FROM canvas_agent_pending_jobs p ${pendingJoins}
    WHERE ${owner} AND p.job_id = $4 AND p.status = 'submitted'`, [...args(scope), jobId])
  return res.rows[0] ? entity<CanvasAgentPendingJob>(res.rows[0]) : null
}
export type CanvasAgentTerminalEventResult = { status: 'marked' | 'duplicate' | 'limit' | 'not_found' | 'busy'; autoContinuationCount?: number }
export async function markCanvasAgentTerminalEvent(
  client: CanvasAgentClient, scope: CanvasAgentScope,
  input: CanvasAgentLease & { jobId: string; maxAutoContinuations: number },
): Promise<CanvasAgentTerminalEventResult> {
  bounded(input.maxAutoContinuations, 0, 10)
  const session = await lockSession(client, scope)
  if (!session || !await findCanvasAgentPendingByJob(client, scope, input.jobId)) return { status: 'not_found' }
  const exists = await client.query(`SELECT e.job_id FROM canvas_agent_terminal_events e JOIN canvas_agent_sessions s ON s.id = e.session_id
    ${joins} WHERE ${owner} AND e.job_id = $4`, [...args(scope), input.jobId])
  if (exists.rows[0]) return { status: 'duplicate', autoContinuationCount: session.autoContinuationCount }
  if (session.autoContinuationCount >= input.maxAutoContinuations) return { status: 'limit', autoContinuationCount: session.autoContinuationCount }
  const res = await client.query(`WITH marked AS (
    INSERT INTO canvas_agent_terminal_events(session_id, job_id, turn_id)
    SELECT s.id, $6, $4 FROM canvas_agent_sessions s ${joins} WHERE ${owner} AND ${activeLease}
    ON CONFLICT(session_id, job_id) DO NOTHING RETURNING session_id
  ) UPDATE canvas_agent_sessions s SET auto_continuation_count = s.auto_continuation_count + 1, updated_at = now()
    FROM marked m, canvas_documents c WHERE m.session_id = s.id AND c.id = s.canvas_id
    AND c.created_by = s.created_by AND c.deleted_at IS NULL AND ${owner} RETURNING s.auto_continuation_count`,
  [...args(scope), input.turnId, input.leaseToken, input.jobId])
  return res.rows[0] ? { status: 'marked', autoContinuationCount: res.rows[0].auto_continuation_count } : { status: 'busy' }
}
/** Verified job summary is API-created, never user-provided. Claim + dedupe + counter + user summary
 * share one short transaction. Duplicate/limit/not_found results do not claim a turn or append a message. */
export async function beginCanvasAgentJobEventTurn(
  client: CanvasAgentClient, scope: CanvasAgentScope,
  input: CanvasAgentTurnInput & { jobId: string; maxAutoContinuations: number }, summary: CanvasAgentMessageInput,
): Promise<CanvasAgentTurnClaim | CanvasAgentTerminalEventResult> {
  bounded(input.maxAutoContinuations, 0, 10)
  const session = await lockSession(client, scope)
  if (!session || !await findCanvasAgentPendingByJob(client, scope, input.jobId)) return { status: 'not_found' }
  // Changed replay must conflict even if its job event was already consumed.
  const prior = await getCanvasAgentTurn(client, scope, input.messageId)
  if (prior && !canvasAgentTurnRequestMatches(prior, input)) return { status: 'conflict' }
  if (prior) return beginCanvasAgentTurn(client, scope, input, summary)
  const exists = await client.query(`SELECT e.job_id FROM canvas_agent_terminal_events e JOIN canvas_agent_sessions s ON s.id = e.session_id
    ${joins} WHERE ${owner} AND e.job_id = $4`, [...args(scope), input.jobId])
  if (exists.rows[0]) return { status: 'duplicate', autoContinuationCount: session.autoContinuationCount }
  if (session.autoContinuationCount >= input.maxAutoContinuations) return { status: 'limit', autoContinuationCount: session.autoContinuationCount }
  const claim = await beginCanvasAgentTurn(client, scope, input, summary)
  if (claim.status !== 'claimed') return claim
  const marked = await markCanvasAgentTerminalEvent(client, scope, { turnId: claim.turn.id, leaseToken: claim.turn.leaseToken,
    jobId: input.jobId, maxAutoContinuations: input.maxAutoContinuations })
  if (marked.status !== 'marked') throw new Error('Canvas agent terminal event invariant failed; roll back transaction')
  return claim
}
/** Admin authorization/model protocol+credential validation are API responsibilities; no model snapshots accepted. */
export async function getCanvasAgentSettings(client: CanvasAgentClient): Promise<CanvasAgentSettingsDto> {
  const res = await client.query('SELECT * FROM canvas_agent_settings WHERE singleton = true')
  if (!res.rows[0]) throw new Error('Canvas agent settings migration not applied')
  return entity<CanvasAgentSettingsDto>(res.rows[0])
}
export async function updateCanvasAgentSettings(
  client: CanvasAgentClient, actorId: string, patch: UpdateCanvasAgentSettingsRequest,
): Promise<CanvasAgentSettingsDto> {
  const columns = { enabled: 'enabled', languageModelConfigId: 'language_model_config_id', maxToolCallsPerTurn: 'max_tool_calls_per_turn',
    maxJobsPerTurn: 'max_jobs_per_turn', timeoutMs: 'timeout_ms', maxAutoContinuations: 'max_auto_continuations' } as const
  const values: unknown[] = [actorId], sets: string[] = []
  for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
    if (patch[key] !== undefined) { values.push(patch[key]); sets.push(`${columns[key]} = $${values.length}`) }
  }
  if (!sets.length || Object.keys(patch).some(key => !Object.hasOwn(columns, key))) throw new Error('Invalid canvas agent settings patch')
  const res = await client.query(`UPDATE canvas_agent_settings SET ${sets.join(', ')}, updated_by = $1, updated_at = now()
    WHERE singleton = true RETURNING *`, values)
  if (!res.rows[0]) throw new Error('Canvas agent settings migration not applied')
  return entity<CanvasAgentSettingsDto>(res.rows[0])
}

function unrecordedPendingOps(recorded: CanvasOp[], pendingOps: CanvasOp[]): CanvasOp[] {
  const key = (op: CanvasOp) => op.type === 'add_node' ? `node:${op.node.id}` : op.type === 'connect' ? `edge:${op.edge.id}` : null
  const seen = new Set(recorded.map(key).filter((id): id is string => id !== null))
  return pendingOps.filter(op => {
    const id = key(op)
    if (!id) return true
    if (seen.has(id)) return false
    seen.add(id); return true
  })
}

/** Only the stable submitted media node and its own edge belong to a pending.
 * Never promote arbitrary stored pending ops into an interrupted turn's scene. */
function submittedMediaOps(pending: CanvasAgentPendingJob[]): CanvasOp[] | null {
  const ops: CanvasOp[] = []
  for (const item of pending.filter(item => item.status === 'submitted')) {
    const nodes = item.ops.filter(op => op.type === 'add_node' && op.node.id === item.nodeId)
    const node = nodes[0]
    if (nodes.length !== 1 || !node || node.type !== 'add_node' || node.node.type !== item.kind
      || !('jobId' in node.node.data) || node.node.data.jobId !== item.jobId) return null
    ops.push(node)
    const edges = item.ops.filter(op => op.type === 'connect' && op.edge.id === item.edgeId && op.edge.target === item.nodeId)
    if (edges.length > 1) return null
    ops.push(...edges)
  }
  return ops
}
/** Recover only add_node ancestors required by submitted edges/sourceNodeId. No unrelated
 * updates/removals/arranges or suggestion edges. All recovered references are validated below. */
function submittedRecoveryOps(scene: CanvasScene, recorded: CanvasOp[], submitted: CanvasOp[]): CanvasOp[] | null {
  const existing = new Set(scene.nodes.map(node => node.id))
  const provided = new Set(submitted.flatMap(op => op.type === 'add_node' ? [op.node.id] : []))
  const dependencies: CanvasOp[] = [], visiting = new Set<string>()
  const sourceOf = (op: CanvasOp) => op.type === 'add_node' && 'sourceNodeId' in op.node.data ? op.node.data.sourceNodeId : undefined
  function requireNode(id: string): boolean {
    if (existing.has(id) || provided.has(id)) return true
    if (visiting.has(id)) return false
    const additions = recorded.filter(op => op.type === 'add_node' && op.node.id === id)
    if (additions.length !== 1) return false
    visiting.add(id)
    const source = sourceOf(additions[0]!)
    if (source && !requireNode(source)) return false
    visiting.delete(id); dependencies.push(additions[0]!); provided.add(id)
    return true
  }
  for (const op of submitted) {
    const source = sourceOf(op)
    if (source && !requireNode(source)) return null
    if (op.type === 'connect' && (!requireNode(op.edge.source) || !requireNode(op.edge.target))) return null
  }
  // Pending rows are read by ID, not execution order. Add all recovered nodes before
  // their edges so two submitted media nodes may safely reference each other.
  return [...dependencies, ...submitted.filter(op => op.type === 'add_node'), ...submitted.filter(op => op.type === 'connect')]
}
export async function applyCanvasAgentTurnScene(
  client: CanvasAgentClient, scope: CanvasAgentScope, input: { turnId: string },
): Promise<
  | { status: 'applied' | 'replay'; revision: number; ops: CanvasOp[] }
  | { status: 'not_found' | 'conflict' | 'invalid_ops'; code?: string }
> {
  const locked = await lockCanvasAgentTurn(client, scope, input.turnId)
  if (!locked) return { status: 'not_found' }
  const { session, turn, canvas: canvasRow } = locked
  const snapshot = parseCanvasAgentMessageRequest(turn.requestSnapshot)
  if (!snapshot.success || snapshot.data.messageId !== turn.messageId || snapshot.data.sceneCommitMode !== 'agent-managed') {
    return { status: 'conflict', code: 'CANVAS_AGENT_APPLY_CONFLICT' }
  }
  // Commit identity is read under serialization, before inspecting later scene revisions.
  if (turn.sceneCommitRevision != null) return { status: 'replay', revision: turn.sceneCommitRevision, ops: turn.sceneCommitOps ?? [] }
  // No new pending can be inserted while the session is locked; confirm uses the same order.
  const pendingRes = await client.query(`SELECT p.* FROM canvas_agent_pending_jobs p ${pendingJoins}
    WHERE ${owner} AND p.turn_id = $4 ORDER BY p.id FOR UPDATE OF p`, [...args(scope), input.turnId])
  const pending = pendingRes.rows.map(row => entity<CanvasAgentPendingJob>(row))
  if (turn.status === 'running' || session.runningTurnId || pending.some(item => item.status === 'pending' || item.status === 'submitting')) {
    return { status: 'conflict', code: 'CANVAS_AGENT_BUSY' }
  }
  const msgRes = await client.query(`SELECT m.ops FROM canvas_agent_messages m WHERE m.session_id = $1 AND m.turn_id = $2 ORDER BY m.seq ASC`,
    [scope.sessionId, input.turnId])
  const messageOps: CanvasOp[] = msgRes.rows.flatMap(row => row.ops ?? [])
  const submittedOps = submittedMediaOps(pending)
  if (!submittedOps) return { status: 'invalid_ops', code: 'INVALID_INPUT' }
  const unavailableNodes = new Set(pending.filter(item => item.status !== 'submitted').map(item => item.nodeId))
  const unavailableEdges = new Set(pending.filter(item => item.status !== 'submitted').map(item => item.edgeId))
  const submittedNodes = new Map(submittedOps.flatMap(op => op.type === 'add_node' ? [[op.node.id, op] as const] : []))
  const submittedEdges = new Map(submittedOps.flatMap(op => op.type === 'connect' ? [[op.edge.id, op] as const] : []))
  // Replace stable placeholders IN PLACE. Appending them after later arrange/update
  // operations would reorder a successful completed turn and break its dependencies.
  const recorded = messageOps.flatMap((op): CanvasOp[] => {
    if (op.type === 'add_node') return unavailableNodes.has(op.node.id) ? [] : [submittedNodes.get(op.node.id) ?? op]
    if (op.type === 'connect') return unavailableNodes.has(op.edge.source) || unavailableNodes.has(op.edge.target)
      ? [] : [submittedEdges.get(op.edge.id) ?? op]
    if ((op.type === 'update_node' || op.type === 'remove_node') && unavailableNodes.has(op.nodeId)) return []
    if (op.type === 'disconnect' && unavailableEdges.has(op.edgeId)) return []
    if (op.type === 'arrange') {
      const positions = op.positions.filter(position => !unavailableNodes.has(position.nodeId))
      return positions.length ? [{ ...op, positions }] : []
    }
    return [op]
  })
  const allOps = turn.status === 'completed'
    ? [...recorded, ...unrecordedPendingOps(recorded, submittedOps)]
    : submittedRecoveryOps(canvasRow.scene, recorded, submittedOps)
  if (snapshot.data.baseRevision !== canvasRow.revision) return { status: 'conflict', code: 'CANVAS_AGENT_APPLY_CONFLICT' }
  if (!allOps) return { status: 'invalid_ops', code: 'INVALID_INPUT' }
  let revision = canvasRow.revision
  if (allOps.length) {
    const applied = applyCanvasOps(canvasRow.scene, allOps)
    if (!applied.success) return { status: 'invalid_ops', code: applied.error.code }
    const check = await validateCanvasReferences(client, scope.actorId,
      { scene: applied.data, coverAssetId: canvasRow.cover_asset_id }, { scene: canvasRow.scene, coverAssetId: canvasRow.cover_asset_id })
    if (!check.valid) return { status: 'invalid_ops', code: check.code }
    const updated = await client.query(`UPDATE canvas_documents SET scene = $3, revision = revision + 1, updated_at = now()
      WHERE id = $2 AND created_by = $1 AND deleted_at IS NULL AND revision = $4 RETURNING revision`,
      [scope.actorId, scope.canvasId, JSON.stringify(applied.data), canvasRow.revision])
    if (!updated.rows[0]) return { status: 'conflict', code: 'CANVAS_REVISION_CONFLICT' }
    revision = updated.rows[0].revision
  }
  await client.query(`UPDATE canvas_agent_turns SET scene_commit_revision = $1, scene_commit_at = now(), scene_commit_ops = $3::jsonb WHERE id = $2`, [revision, turn.id, JSON.stringify(allOps)])
  return { status: 'applied', revision, ops: allOps }
}
