import type pg from 'pg'
import { CanvasErrorCode as C, parseCanvasScene, parseCanvasAgentMessageRequest, type CanvasAgentTurnRecoveryDto, type CanvasAgentStructuredContext, type CanvasAgentMessageRequest, type CanvasScene, type CanvasAgentSettingsDto, type CanvasOp, type JsonValue, type JsonObject, type CanvasAgentConfirmRequest, type CanvasAgentStatusDto } from '@musecanvas/contracts'
import * as repo from '@musecanvas/database'
import type { CanvasAgentLease, CanvasAgentScope, CanvasAgentPendingJob, CanvasAgentStoredMessage, CreateCanvasAgentPendingInput, CanvasAgentMessageInput } from '@musecanvas/database'
import type { LanguageModelChatInput } from '@musecanvas/providers'
import { hasStoredCredentialSecret } from '@musecanvas/providers'
import { capabilitiesFromRow, defaultsFromRow, publicModelDto } from '../../../shared/dto'
import { publicTurn } from './history'
import { storeReadyInputImage, type ReadyInputWrite } from '../../image-edit/handlers'
import { assertStorageStrings, modelConfigDigest, raise, runtimeConfig, validateLanguageConfig, AgentError } from './config'

export interface SavedCanvas { revision: number; scene: CanvasScene }
export interface RunContext {
  context?: CanvasAgentStructuredContext
  requestSnapshot?: CanvasAgentMessageRequest
  scope: CanvasAgentScope; lease: CanvasAgentLease; canvas: SavedCanvas; settings: CanvasAgentSettingsDto
  baseRevision: number; deadline: number; turnStatus: repo.CanvasAgentTurnStatus; turnErrorCode: import('@musecanvas/contracts').CanvasErrorCode | null; cleanupCode?: string; leaseReleased?: boolean
  config: Omit<LanguageModelChatInput, 'system' | 'messages' | 'tools' | 'signal'>
  requireConfirmation: boolean; autoContinuationCount: number; replay: boolean
  messages: CanvasAgentStoredMessage[]; pending: CanvasAgentPendingJob[]; attemptedCalls: number
}
export interface MediaModel { row: Record<string, any>; digest: string; capabilities: ReturnType<typeof capabilitiesFromRow>; defaults: ReturnType<typeof defaultsFromRow> }
export interface AgentStore {
  turn(actorId: string, canvasId: string, turnId: string): Promise<CanvasAgentTurnRecoveryDto>
  existingPending(ctx: RunContext, toolCallId: string): Promise<CanvasAgentPendingJob | null>
  reserveEdit(ctx: RunContext, toolCallId: string, identity: JsonObject): Promise<repo.CanvasAgentEditPreparation>
  stageEditMask(ctx: RunContext, preparation: repo.CanvasAgentEditPreparation, row: ReadyInputWrite & { sourceChecksum: string }, put: () => Promise<void>): Promise<void>
  completeEdit(ctx: RunContext, preparation: repo.CanvasAgentEditPreparation, snapshot: repo.CanvasAgentPreparedEdit): Promise<repo.CanvasAgentEditPreparation>
  start(actorId: string, canvasId: string, request: CanvasAgentMessageRequest): Promise<RunContext>
  history(actorId: string, canvasId: string, afterSeq: number, limit: number, beforeSeq?: number): Promise<{ scope: CanvasAgentScope; session: repo.CanvasAgentSession; messages: CanvasAgentStoredMessage[]; nextAfterSeq: number | null; nextBeforeSeq?: number | null; pending: CanvasAgentPendingJob[] }>
  recordRound(ctx: RunContext, assistant: CanvasAgentMessageInput): Promise<CanvasAgentStoredMessage[]>
  result(ctx: RunContext, messageId: string, content: string, ops: CanvasOp[]): Promise<void>
  finish(ctx: RunContext, output: CanvasAgentMessageInput): Promise<CanvasAgentStoredMessage>
  release(ctx: RunContext, code: string): Promise<void>
  validateReferences(ctx: RunContext, ops: CanvasOp[], scene: CanvasScene): Promise<void>
  models(mode?: string): Promise<JsonValue>
  mediaModel(modelId: string, kind: 'image' | 'video'): Promise<MediaModel>
  source(actorId: string, canvasId: string, nodeId: string): Promise<string>
  pending(ctx: RunContext, input: CreateCanvasAgentPendingInput): Promise<CanvasAgentPendingJob>
  claim(actorId: string, canvasId: string, request: CanvasAgentConfirmRequest, timeoutMs: number): Promise<{ scope: CanvasAgentScope; pending: CanvasAgentPendingJob; claimed: boolean }>
  complete(scope: CanvasAgentScope, pending: CanvasAgentPendingJob, jobId: string): Promise<CanvasAgentPendingJob>
  apply(actorId: string, canvasId: string, turnId: string): Promise<Awaited<ReturnType<typeof repo.applyCanvasAgentTurnScene>>>
  status(): Promise<CanvasAgentStatusDto>
}
async function readCanvas(client: pg.PoolClient, actorId: string, canvasId: string): Promise<SavedCanvas> {
  const row = (await client.query('SELECT revision,scene FROM canvas_documents WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL', [canvasId, actorId])).rows[0]
  if (!row) raise(C.CANVAS_NOT_FOUND, 404)
  const parsed = parseCanvasScene(row.scene)
  if (!parsed.success) raise(C.CANVAS_AGENT_FAILED, 503)
  return { revision: row.revision, scene: parsed.data }
}
async function scopeFor(client: pg.PoolClient, actorId: string, canvasId: string) {
  const session = await repo.getOrCreateCanvasAgentSession(client, { actorId, canvasId })
  if (!session) raise(C.CANVAS_NOT_FOUND, 404)
  return { session, scope: { actorId, canvasId, sessionId: session.id } }
}
async function allPending(client: pg.PoolClient, scope: CanvasAgentScope) {
  const items: CanvasAgentPendingJob[] = []; let afterId: string | undefined
  do { const page = await repo.readCanvasAgentPendingJobs(client, scope, { afterId, limit: 200 }); items.push(...page.pendingJobs); afterId = page.nextAfterId ?? undefined } while (afterId)
  return items
}
async function recentMessages(client: pg.PoolClient, scope: CanvasAgentScope): Promise<CanvasAgentStoredMessage[]> {
  // Select complete turns, not the last N messages (which can bisect tool pairs).
  const turns = (await client.query(`SELECT t.id FROM canvas_agent_turns t JOIN canvas_agent_sessions s ON s.id=t.session_id
    JOIN canvas_documents c ON c.id=s.canvas_id AND c.created_by=s.created_by AND c.deleted_at IS NULL
    WHERE s.id=$3 AND s.created_by=$1 AND s.canvas_id=$2 AND c.created_by=$1 ORDER BY t.started_at DESC,t.id DESC LIMIT 8`, [scope.actorId, scope.canvasId, scope.sessionId])).rows.map(row => row.id)
  if (!turns.length) return []
  const messages = (await client.query(`SELECT m.*, m.session_id AS "sessionId",m.turn_id AS "turnId",m.tool_calls AS "toolCalls",m.content_blocks AS "contentBlocks",m.created_at AS "createdAt"
    FROM canvas_agent_messages m JOIN canvas_agent_sessions s ON s.id=m.session_id
    JOIN canvas_documents c ON c.id=s.canvas_id AND c.created_by=s.created_by AND c.deleted_at IS NULL
    WHERE s.id=$3 AND s.created_by=$1 AND s.canvas_id=$2 AND c.created_by=$1 AND m.turn_id=ANY($4::uuid[]) ORDER BY m.seq`, [scope.actorId, scope.canvasId, scope.sessionId, turns])).rows
  return messages.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString(), ...(row.input_tokens == null ? {} : { usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens } }) }))
}
async function mediaModel(client: pg.PoolClient, modelId: string, kind: 'image' | 'video'): Promise<MediaModel> {
  const row = (await client.query(`SELECT m.*,rev.capabilities,rev.defaults FROM model_configs m LEFT JOIN model_config_revisions rev ON rev.id=m.latest_revision_id
    WHERE m.id=$1 AND m.model_kind=$2 AND m.enabled=true AND m.deleted_at IS NULL`, [modelId, kind])).rows[0]
  if (!row) raise(C.INVALID_INPUT)
  const credential = row.provider_credential_id ? await repo.findProviderCredential(client, row.provider_credential_id) : null
  if (!credential || !credential.enabled || !hasStoredCredentialSecret(credential)) raise(C.INVALID_INPUT)
  const capabilities = capabilitiesFromRow(row)
  if (capabilities.declaredBy === 'undeclared' || !capabilities.supportedMediaKinds.includes(kind)) raise(C.INVALID_INPUT)
  return { row, digest: modelConfigDigest(row, credential), capabilities, defaults: defaultsFromRow(row) }
}
async function source(client: pg.PoolClient, actorId: string, canvasId: string, nodeId: string) {
  const canvas = await readCanvas(client, actorId, canvasId)
  const node = canvas.scene.nodes.find(node => node.id === nodeId)
  if (!node || node.type !== 'image' || !node.data.assetId) raise(C.SOURCE_NOT_READY, 409)
  const asset = (await client.query("SELECT id FROM assets WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL AND media_kind='image'", [node.data.assetId, actorId])).rows[0]
  if (!asset) raise(C.SOURCE_NOT_READY, 409)
  return node.data.assetId
}
async function terminalSummary(client: pg.PoolClient, scope: CanvasAgentScope, jobId: string): Promise<string> {
  if (!await repo.findCanvasAgentPendingByJob(client, scope, jobId)) raise(C.INVALID_INPUT)
  const job = (await client.query('SELECT id,status,error_code FROM generation_jobs WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL', [jobId, scope.actorId])).rows[0]
  if (!job || !['succeeded', 'failed', 'canceled'].includes(job.status)) raise(C.INVALID_INPUT)
  const assets = job.status === 'succeeded' ? (await client.query('SELECT id,media_kind FROM assets WHERE job_id=$1 AND created_by=$2 AND deleted_at IS NULL ORDER BY id LIMIT 8', [jobId, scope.actorId])).rows : []
  if (job.status === 'succeeded' && !assets.length) raise(C.SOURCE_NOT_READY, 409)
  return JSON.stringify({ kind: 'verified_job_event', jobId, status: job.status, assets, error: job.status === 'succeeded' ? null : { code: 'GENERATION_FAILED' } })
}

/** Resolve only the immutable owned lineage, never provider/latest-history text.
 * Legacy null snapshots cannot reconstruct constraints; corrupt/foreign/cyclic
 * lineage is refused rather than silently producing an unconstrained proposal. */
export async function inheritedJobEventContext(client: pg.PoolClient, scope: CanvasAgentScope, jobId: string): Promise<CanvasAgentStructuredContext | undefined> {
  const seen = new Set<string>()
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(jobId)) raise(C.INVALID_INPUT)
    seen.add(jobId)
    const pending = await repo.findCanvasAgentPendingByJob(client, scope, jobId)
    const job = (await client.query('SELECT id FROM generation_jobs WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL', [jobId, scope.actorId])).rows[0]
    if (!job || !pending || pending.createdBy !== scope.actorId || pending.canvasId !== scope.canvasId || pending.sessionId !== scope.sessionId || pending.jobId !== jobId) raise(C.INVALID_INPUT)
    const turn = await repo.getCanvasAgentTurnById(client, scope, pending.turnId)
    if (!turn || turn.sessionId !== scope.sessionId) raise(C.INVALID_INPUT)
    if (turn.requestSnapshot == null) return undefined
    const parsed = parseCanvasAgentMessageRequest(turn.requestSnapshot)
    if (!parsed.success || parsed.data.messageId !== turn.messageId
      || repo.canvasAgentRequestDigest(parsed.data as unknown as JsonObject) !== turn.requestDigest) raise(C.INVALID_INPUT)
    if (parsed.data.kind === 'user') return parsed.data.context
    jobId = parsed.data.jobId
  }
  return raise(C.INVALID_INPUT)
}

export class PgAgentStore implements AgentStore {
  constructor(private readonly tx: typeof repo.transaction = repo.transaction) {}
  async start(actorId: string, canvasId: string, request: CanvasAgentMessageRequest): Promise<RunContext> {
    const parsedRequest = parseCanvasAgentMessageRequest(request)
    if (!parsedRequest.success) raise(C.INVALID_INPUT)
    request = parsedRequest.data
    return this.tx(async client => {
      const canvas = await readCanvas(client, actorId, canvasId)
      const { scope, session } = await scopeFor(client, actorId, canvasId)
      const settings = await repo.getCanvasAgentSettings(client), config = await runtimeConfig(client, settings)
      const prior = await repo.getCanvasAgentTurn(client, scope, request.messageId)
      if ((!prior || prior.status === 'running') && request.baseRevision !== canvas.revision) raise(C.CANVAS_REVISION_CONFLICT, 409)
      const input = {
        messageId: request.messageId,
        requestDigest: repo.canvasAgentRequestDigest(request as unknown as JsonObject),
        timeoutMs: settings.timeoutMs,
        requestSnapshot: request as unknown as JsonObject,
      }
      const summary = request.kind === 'user' ? request.text : await terminalSummary(client, scope, request.jobId)
      const explicitContext = request.kind === 'user' ? request.context : await inheritedJobEventContext(client, scope, request.jobId)
      const contextBlocks = explicitContext ? [{ type: 'canvas_agent_context', context: explicitContext as unknown as JsonObject }] : []
      const claim = request.kind === 'user'
        ? await repo.beginCanvasAgentTurn(client, scope, { ...input, requireConfirmation: request.requireConfirmation }, { role: 'user', content: summary, contentBlocks: contextBlocks })
        : await repo.beginCanvasAgentJobEventTurn(client, scope, { ...input, jobId: request.jobId, maxAutoContinuations: settings.maxAutoContinuations }, { role: 'user', content: summary, contentBlocks: contextBlocks })
      if (claim.status !== 'claimed' && claim.status !== 'replay') {
        if (claim.status === 'limit') raise(C.CANVAS_AGENT_AUTO_CONTINUATION_LIMIT, 409)
        if (claim.status === 'duplicate') raise(C.CANVAS_AGENT_MESSAGE_CONFLICT, 409)
        raise(claim.status === 'busy' ? C.CANVAS_AGENT_BUSY : C.CANVAS_AGENT_MESSAGE_CONFLICT, 409)
      }
      const current = await repo.getCanvasAgentSession(client, scope) ?? session
      let messages: CanvasAgentStoredMessage[]
      if (claim.status === 'replay') {
        messages = []; let afterSeq = 0
        do {
          const page = await repo.readCanvasAgentTurnMessages(client, scope, claim.turn.id, { afterSeq, limit: 200 })
          messages.push(...page.messages); afterSeq = page.nextAfterSeq ?? 0
        } while (afterSeq)
      } else messages = await recentMessages(client, scope)
      return { requestSnapshot: request, ...(explicitContext ? { context: explicitContext } : {}), scope, lease: { turnId: claim.turn.id, leaseToken: claim.turn.leaseToken }, canvas, settings, config, requireConfirmation: request.kind === 'job_event' || request.sceneCommitMode === 'agent-managed' || (request.kind === 'user' && request.context !== undefined) ? true : current.requireConfirmation,
        autoContinuationCount: current.autoContinuationCount, replay: claim.status === 'replay', messages, pending: await allPending(client, scope),
        baseRevision: request.baseRevision, deadline: Date.parse(claim.turn.leaseExpiresAt), turnStatus: claim.turn.status, turnErrorCode: claim.turn.errorCode as import('@musecanvas/contracts').CanvasErrorCode | null,
        attemptedCalls: messages.filter(m => m.turnId === claim.turn.id).reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0) }
    })
  }
  async turn(actorId: string, canvasId: string, turnId: string): Promise<CanvasAgentTurnRecoveryDto> {
    return this.tx(async client => {
      await readCanvas(client, actorId, canvasId)
      const session = await repo.findCanvasAgentSessionForCanvas(client, { actorId, canvasId })
      if (!session) raise(C.CANVAS_NOT_FOUND, 404)
      const scope = { actorId, canvasId, sessionId: session.id }
      const turn = await repo.getCanvasAgentTurnById(client, scope, turnId)
      if (!turn) raise(C.CANVAS_NOT_FOUND, 404)
      const pending = await repo.readCanvasAgentTurnPendingJobs(client, scope, turnId)
      return publicTurn(turn, pending)
    })
  }
  async existingPending(ctx: RunContext, toolCallId: string): Promise<CanvasAgentPendingJob | null> {
    return this.tx(async client => {
      const ids = repo.canvasAgentPendingIdentity(ctx.scope.canvasId, toolCallId)
      const pending = await repo.getCanvasAgentPendingJob(client, ctx.scope, ids.id)
      return pending?.turnId === ctx.lease.turnId ? pending : null
    })
  }
  async reserveEdit(ctx: RunContext, toolCallId: string, identity: JsonObject): Promise<repo.CanvasAgentEditPreparation> {
    return this.tx(async client => {
      const source = (await client.query("SELECT checksum FROM assets WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL AND media_kind='image'", [identity.sourceAssetId, ctx.scope.actorId])).rows[0]
      if (!source || !/^[0-9a-f]{64}$/.test(source.checksum)) raise(C.SOURCE_NOT_READY, 409)
      const ttl = (await client.query('SELECT upload_ttl_seconds FROM runtime_settings WHERE singleton=true')).rows[0]?.upload_ttl_seconds ?? 86400
      try {
        return await repo.reserveCanvasAgentEditPreparation(client, ctx.scope, ctx.lease, { toolCallId, requestSnapshot: { ...identity, sourceChecksum: source.checksum }, leaseMs: Math.min(ctx.settings.timeoutMs, 60000), ttlSeconds: Math.min(ttl, 900) })
      } catch (error) {
        if (error instanceof Error && error.message === 'PREPARATION_EXPIRED') raise(C.CANVAS_AGENT_CONFIRM_EXPIRED, 409)
        if (error instanceof Error && error.message === 'PREPARATION_BUSY') raise(C.CANVAS_AGENT_BUSY, 409)
        raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      }
    })
  }
  async stageEditMask(ctx: RunContext, preparation: repo.CanvasAgentEditPreparation, row: ReadyInputWrite & { sourceChecksum: string }, put: () => Promise<void>): Promise<void> {
    if (row.uploadId !== preparation.maskUploadId || row.actorId !== ctx.scope.actorId || row.expiresAt !== preparation.expiresAt) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
    const rows = async (client: pg.PoolClient) => {
      const existing: Record<string, any>[] = []
      for (const table of ['media_uploads', 'generation_input_images']) {
        existing.push(...(await client.query(`SELECT status,attached_job_id,object_key,mime_type,width,height,size_bytes,checksum,expires_at,deleted_at FROM ${table}
          WHERE id=$1 AND created_by=$2 FOR UPDATE`, [row.uploadId, ctx.scope.actorId])).rows)
      }
      if (existing.length && (existing.length !== 2 || existing.some(saved => !['pending','ready'].includes(saved.status) || saved.attached_job_id || saved.deleted_at
        || saved.object_key !== row.objectKey || saved.mime_type !== row.mimeType || saved.width !== row.width || saved.height !== row.height
        || Number(saved.size_bytes) !== row.sizeBytes || saved.checksum !== row.checksum || new Date(saved.expires_at).toISOString() !== row.expiresAt))) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      return existing
    }
    await this.tx(async client => {
      await repo.freezeCanvasAgentPreparationArtifact(client, ctx.scope, ctx.lease, preparation, { checksum: row.checksum, sourceChecksum: row.sourceChecksum, width: row.width, height: row.height, sizeBytes: row.sizeBytes })
      // Existing TTL cleanup sees this key even if the process dies after PUT.
      if (!(await rows(client)).length) await storeReadyInputImage(client, row, 'pending')
    })
    await put() // Conditional immutable object write, outside every DB transaction.
    await this.tx(async client => {
      if (!await repo.fenceCanvasAgentEditPreparation(client, ctx.scope, ctx.lease, preparation)) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      if ((await rows(client)).length !== 2) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      for (const table of ['media_uploads', 'generation_input_images']) {
        await client.query(`UPDATE ${table} SET status='ready',updated_at=clock_timestamp() WHERE id=$1 AND created_by=$2
          AND status='pending' AND attached_job_id IS NULL AND deleted_at IS NULL AND expires_at>clock_timestamp()`, [row.uploadId, ctx.scope.actorId])
      }
      if ((await rows(client)).some(saved => saved.status !== 'ready')) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
    })
  }

  async completeEdit(ctx: RunContext, preparation: repo.CanvasAgentEditPreparation, snapshot: repo.CanvasAgentPreparedEdit): Promise<repo.CanvasAgentEditPreparation> {
    return this.tx(async client => {
      const mask = (await client.query('SELECT checksum FROM media_uploads WHERE id=$1 AND created_by=$2 AND status=\'ready\' AND attached_job_id IS NULL AND deleted_at IS NULL AND expires_at>clock_timestamp()', [preparation.maskUploadId, ctx.scope.actorId])).rows[0]
      const artifact = (await client.query('SELECT artifact FROM canvas_agent_preparations WHERE id=$1 AND created_by=$2', [preparation.id, ctx.scope.actorId])).rows[0]?.artifact
      if (!mask || !artifact || mask.checksum !== artifact.checksum) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      return repo.completeCanvasAgentEditPreparation(client, ctx.scope, ctx.lease, preparation, snapshot)
    })
  }
  async history(actorId: string, canvasId: string, afterSeq: number, limit: number, beforeSeq?: number) {
    return this.tx(async client => {
      await readCanvas(client, actorId, canvasId)
      const { scope, session } = await scopeFor(client, actorId, canvasId)
      return { scope, session, ...await repo.readCanvasAgentMessages(client, scope, { afterSeq: beforeSeq === undefined ? afterSeq : undefined, beforeSeq, limit }), pending: await allPending(client, scope) }
    })
  }
  async apply(actorId: string, canvasId: string, turnId: string) {
    return this.tx(async client => {
      await readCanvas(client, actorId, canvasId)
      const { scope } = await scopeFor(client, actorId, canvasId)
      return repo.applyCanvasAgentTurnScene(client, scope, { turnId })
    })
  }
  async status(): Promise<CanvasAgentStatusDto> {
    return this.tx(async client => {
      const settings = await repo.getCanvasAgentSettings(client)
      let available = false
      let reason: CanvasAgentStatusDto['reason'] = 'ready'
      if (!settings.enabled) {
        reason = 'disabled'
      } else if (!settings.languageModelConfigId) {
        reason = 'not_configured'
      } else {
        try {
          await validateLanguageConfig(client, settings.languageModelConfigId)
          available = true
          reason = 'ready'
        } catch (err) {
          available = false
          reason = err instanceof AgentError && err.code === C.CANVAS_AGENT_MODEL_UNSUPPORTED
            ? 'model_unsupported'
            : 'not_configured'
        }
      }
      return {
        enabled: settings.enabled,
        available,
        reason,
        maxToolCallsPerTurn: settings.maxToolCallsPerTurn,
        maxJobsPerTurn: settings.maxJobsPerTurn,
        timeoutMs: settings.timeoutMs,
        maxAutoContinuations: settings.maxAutoContinuations,
      }
    })
  }
  async recordRound(ctx: RunContext, assistant: CanvasAgentMessageInput) {
    assertStorageStrings(assistant)
    return this.tx(async client => {
      const output: CanvasAgentStoredMessage[] = []
      const first = await repo.appendCanvasAgentMessage(client, ctx.scope, assistant, ctx.lease)
      if (!first) raise(C.CANVAS_AGENT_TIMEOUT, 409)
      output.push(first)
      for (const call of assistant.toolCalls ?? []) {
        const result = await repo.appendCanvasAgentMessage(client, ctx.scope, { role: 'tool', content: JSON.stringify({ toolCallId: call.id, success: false, error: { code: C.CANVAS_AGENT_CANCELED } }) }, ctx.lease)
        if (!result) raise(C.CANVAS_AGENT_TIMEOUT, 409)
        output.push(result)
      }
      return output
    })
  }
  async result(ctx: RunContext, messageId: string, content: string, ops: CanvasOp[]) {
    assertStorageStrings([content, ops])
    await this.tx(async client => {
      // Lock session BEFORE message rows, matching append/takeover order. After a
      // wait, a fresh statement must fence the CURRENT token and database clock.
      const locked = await client.query(`SELECT s.id FROM canvas_agent_sessions s JOIN canvas_documents c
        ON c.id=s.canvas_id AND c.created_by=s.created_by AND c.deleted_at IS NULL
        WHERE s.created_by=$1 AND s.canvas_id=$2 AND s.id=$3 AND c.created_by=$1 FOR UPDATE OF s`,
      [ctx.scope.actorId, ctx.scope.canvasId, ctx.scope.sessionId])
      if (!locked.rows[0]) raise(C.CANVAS_AGENT_TIMEOUT, 409)
      const active = await client.query(`SELECT s.id FROM canvas_agent_sessions s JOIN canvas_documents c
        ON c.id=s.canvas_id AND c.created_by=s.created_by AND c.deleted_at IS NULL
        WHERE s.created_by=$1 AND s.canvas_id=$2 AND s.id=$3 AND c.created_by=$1
        AND s.running_turn_id=$4 AND s.running_lease_token=$5 AND s.running_lease_expires_at>clock_timestamp()`,
      [ctx.scope.actorId, ctx.scope.canvasId, ctx.scope.sessionId, ctx.lease.turnId, ctx.lease.leaseToken])
      if (!active.rows[0]) raise(C.CANVAS_AGENT_TIMEOUT, 409)
      const result = await client.query(`UPDATE canvas_agent_messages m SET content=$7,ops=$8::jsonb FROM canvas_agent_sessions s,canvas_documents c
        WHERE m.id=$6 AND m.session_id=s.id AND m.role='tool' AND m.turn_id=$4 AND s.created_by=$1 AND s.canvas_id=$2 AND s.id=$3
        AND c.id=s.canvas_id AND c.created_by=$1 AND c.deleted_at IS NULL AND s.running_turn_id=$4 AND s.running_lease_token=$5 AND s.running_lease_expires_at>now() AND s.running_lease_expires_at>clock_timestamp() RETURNING m.id`,
      [ctx.scope.actorId, ctx.scope.canvasId, ctx.scope.sessionId, ctx.lease.turnId, ctx.lease.leaseToken, messageId, content, JSON.stringify(ops)])
      if (!result.rows[0]) raise(C.CANVAS_AGENT_TIMEOUT, 409)
    })
  }
  async finish(ctx: RunContext, output: CanvasAgentMessageInput) {
    assertStorageStrings(output)
    return this.tx(async client => {
      const message = await repo.finishCanvasAgentTurn(client, ctx.scope, ctx.lease, output)
      if (!message) raise(C.CANVAS_AGENT_TIMEOUT, 409)
      return message
    })
  }
  async release(ctx: RunContext, code: string) { await this.tx(client => repo.releaseCanvasAgentTurn(client, ctx.scope, ctx.lease, code === C.CANVAS_AGENT_CANCELED ? 'canceled' : 'failed', code)) }
  async validateReferences(ctx: RunContext, ops: CanvasOp[], scene: CanvasScene) {
    await this.tx(async client => {
      for (const op of ops) {
        const data = op.type === 'add_node' ? op.node.data : op.type === 'update_node' ? op.patch.data : null
        if (!data) continue
        if ('assetId' in data && data.assetId) {
          const asset = (await client.query('SELECT media_kind FROM assets WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL', [data.assetId, ctx.scope.actorId])).rows[0]
          const node = op.type === 'add_node' ? op.node : scene.nodes.find(n => n.id === (op as { nodeId: string }).nodeId)
          if (!asset || !node || asset.media_kind !== node.type) raise(C.INVALID_INPUT)
        }
        if ('jobId' in data && data.jobId) {
          const job = (await client.query('SELECT id,media_kind FROM generation_jobs WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL', [data.jobId, ctx.scope.actorId])).rows[0]
          const node = op.type === 'add_node' ? op.node : scene.nodes.find(n => n.id === (op as { nodeId: string }).nodeId)
          if (!job || !node || job.media_kind !== node.type) raise(C.INVALID_INPUT)
        }
        if ('modelId' in data && data.modelId) {
          const model = (await client.query("SELECT id FROM model_configs WHERE id=$1 AND enabled=true AND deleted_at IS NULL AND model_kind IN ('image','video')", [data.modelId])).rows[0]
          if (!model) raise(C.INVALID_INPUT)
        }
      }
    })
  }
  async models(mode?: string): Promise<JsonValue> {
    return this.tx(async client => {
      const rows = (await client.query(`SELECT m.*,rev.capabilities,rev.defaults FROM model_configs m LEFT JOIN model_config_revisions rev ON rev.id=m.latest_revision_id
        JOIN provider_credentials pc ON pc.id=m.provider_credential_id AND pc.enabled=true AND pc.deleted_at IS NULL
        WHERE m.model_kind IN ('image','video') AND m.enabled=true AND m.deleted_at IS NULL
        AND COALESCE(NULLIF(pc.payload_encrypted,''),NULLIF(pc.api_key_encrypted,'')) IS NOT NULL ORDER BY m.sort_order,m.id LIMIT 100`)).rows
      return rows.map(publicModelDto).filter(dto => !mode || dto.modes.includes(mode as never)) as unknown as JsonValue
    })
  }
  mediaModel(modelId: string, kind: 'image' | 'video') { return this.tx(client => mediaModel(client, modelId, kind)) }
  source(actorId: string, canvasId: string, nodeId: string) { return this.tx(client => source(client, actorId, canvasId, nodeId)) }
  async pending(ctx: RunContext, input: CreateCanvasAgentPendingInput) {
    return this.tx(async client => {
      const session = await client.query(`SELECT s.id FROM canvas_agent_sessions s JOIN canvas_documents c ON c.id=s.canvas_id AND c.created_by=s.created_by AND c.deleted_at IS NULL
        WHERE s.id=$3 AND s.created_by=$1 AND s.canvas_id=$2 AND c.created_by=$1 FOR UPDATE OF s`, [ctx.scope.actorId, ctx.scope.canvasId, ctx.scope.sessionId])
      if (!session.rows[0]) raise(C.CANVAS_NOT_FOUND, 404)
      const count = (await client.query('SELECT count(*)::int AS count FROM canvas_agent_pending_jobs WHERE session_id=$1 AND turn_id=$2', [ctx.scope.sessionId, ctx.lease.turnId])).rows[0].count
      const identity = repo.canvasAgentPendingIdentity(ctx.scope.canvasId, input.toolCallId)
      const existing = await repo.getCanvasAgentPendingJob(client, ctx.scope, identity.id)
      if (!existing && count >= ctx.settings.maxJobsPerTurn) raise(C.CANVAS_AGENT_BUDGET_EXCEEDED, 409)
      const canvas = await readCanvas(client, ctx.scope.actorId, ctx.scope.canvasId)
      if (canvas.revision !== input.baseRevision) raise(C.CANVAS_REVISION_CONFLICT, 409)
      if (input.sourceNodeId && await source(client, ctx.scope.actorId, ctx.scope.canvasId, input.sourceNodeId) !== input.sourceAssetId) raise(C.SOURCE_NOT_READY, 409)
      const model = await mediaModel(client, input.modelId, input.kind)
      if (model.digest !== input.modelConfigDigest) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      if (!existing) for (const item of input.normalizedInputs ?? []) {
        const row = item.assetId
          ? (await client.query('SELECT media_kind FROM assets WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL', [item.assetId, ctx.scope.actorId])).rows[0]
          : (await client.query(`SELECT media_kind FROM media_uploads WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL
              AND status='ready' AND attached_job_id IS NULL AND expires_at>clock_timestamp()
              UNION ALL SELECT 'image' AS media_kind FROM generation_input_images g WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL
              AND status='ready' AND attached_job_id IS NULL AND expires_at>clock_timestamp() AND NOT EXISTS (SELECT 1 FROM media_uploads WHERE id=g.id)`, [item.uploadId, ctx.scope.actorId])).rows[0]
        const slot = model.capabilities.inputSlots.find(slot => slot.role === item.role)
        // Single-use/expired/foreign inputs require a new user proposal with a
        // ready input (or reusable gallery asset), never a silent replacement.
        if (!row) raise(C.SOURCE_NOT_READY, 409)
        if (!slot || !slot.allowedMediaKinds.includes(row.media_kind)) raise(C.INVALID_INPUT)
      }
      const result = await repo.createCanvasAgentPendingJob(client, ctx.scope, ctx.lease, input)
      if (result.status !== 'created' && result.status !== 'replay') raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      return result.pending
    })
  }
  async claim(actorId: string, canvasId: string, request: CanvasAgentConfirmRequest, timeoutMs: number) {
    const result = await this.tx(async client => {
      const { scope } = await scopeFor(client, actorId, canvasId)
      const beforeLock = await repo.getCanvasAgentPendingJob(client, scope, request.pendingId)
      if (!beforeLock || !await repo.lockCanvasAgentTurn(client, scope, beforeLock.turnId)) raise(C.CANVAS_AGENT_CONFIRM_NOT_FOUND, 404)
      const canvas = await readCanvas(client, actorId, canvasId)
      const pending = await repo.getCanvasAgentPendingJob(client, scope, request.pendingId)
      if (!pending) raise(C.CANVAS_AGENT_CONFIRM_NOT_FOUND, 404)
      if (pending.status === 'submitted') {
        const bound = await repo.completeCanvasAgentPendingJob(client, scope, { pendingId: pending.id, leaseToken: pending.id, jobId: pending.jobId! })
        if (bound.status !== 'replay') raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
        return { scope, pending: bound.pending, claimed: false }
      }
      const existing = request.approve ? (await client.query('SELECT id,media_kind,model_id,normalized_request FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2 AND deleted_at IS NULL', [actorId, pending.idempotencyKey])).rows[0] : undefined
      if (existing && !repo.canvasAgentGenerationJobMatches(pending, existing)) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      if (request.approve && pending.status === 'submitting') {
        if (existing) {
          const claim = await repo.claimCanvasAgentPendingJob(client, scope, pending.id, timeoutMs)
          if (claim.status !== 'claimed') raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
          const completed = await repo.completeCanvasAgentPendingJob(client, scope, { pendingId: pending.id, leaseToken: claim.pending.leaseToken!, jobId: existing.id })
          if (completed.status !== 'completed' && completed.status !== 'replay') raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
          return { scope, pending: completed.pending, claimed: false }
        }
      }
      if (!request.approve) {
        const rejected = await repo.rejectCanvasAgentPendingJob(client, scope, pending.id)
        if (rejected.status === 'busy' || rejected.status === 'not_found') raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
        return { scope, pending: rejected.pending, claimed: false }
      }
      const settings = await repo.getCanvasAgentSettings(client)
      if (!settings.enabled) raise(C.CANVAS_AGENT_DISABLED, 409)
      await runtimeConfig(client, settings)
      if (canvas.revision !== pending.baseRevision) {
        await client.query(`UPDATE canvas_agent_pending_jobs SET status='expired',updated_at=now() WHERE id=$1 AND created_by=$2 AND canvas_id=$3 AND session_id=$4 AND status='pending'`, [pending.id, actorId, canvasId, scope.sessionId])
        return { error: C.CANVAS_AGENT_CONFIRM_CONFLICT }
      }
      if (pending.sourceNodeId && await source(client, actorId, canvasId, pending.sourceNodeId) !== pending.sourceAssetId) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      const model = await mediaModel(client, pending.modelId, pending.kind)
      if (model.digest !== pending.modelConfigDigest) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      const claim = await repo.claimCanvasAgentPendingJob(client, scope, pending.id, timeoutMs)
      if (claim.status === 'expired') return { error: C.CANVAS_AGENT_CONFIRM_EXPIRED }
      if (claim.status !== 'claimed' && claim.status !== 'replay') raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      return { scope, pending: claim.pending, claimed: claim.status === 'claimed' }
    })
    if ('error' in result) raise(result.error!, 409)
    return result
  }
  async complete(scope: CanvasAgentScope, pending: CanvasAgentPendingJob, jobId: string) {
    return this.tx(async client => {
      const result = await repo.completeCanvasAgentPendingJob(client, scope, { pendingId: pending.id, leaseToken: pending.leaseToken!, jobId })
      if (result.status !== 'completed' && result.status !== 'replay') raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      return result.pending
    })
  }
}
