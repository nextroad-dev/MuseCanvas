import type { AgentBudgetDTO, AgentTurnDTO, GenerationMode, JsonObject, ParameterDescriptor } from '@musecanvas/contracts'
import {
  appendAgentMediaProposalToolCall, canvasAgentRequestDigest, createPendingAgentMediaApproval,
  type AgentCoreClient,
} from '@musecanvas/database'
import {
  capabilitiesFromRow, generationEffectBindingHash, lockManagedGenerationInputs, MediaServiceError, prepareGeneration,
  type AgentBindingInput, type GenerationInputLimits,
} from '@musecanvas/media-service'
import type { AgentSqlClient, AgentToolBudgetPort, AgentToolContext, AgentTurnScope } from './ports'

/**
 * V1 generations are free: migration 0024 removed billing. The estimated-cost
 * reservation exists only so the approval binds an explicit, zero-cost figure.
 * Never invent a nonzero price for approval to bind.
 */
export const AGENT_MEDIA_FREE_PRICING = {
  amount: '0', currency: 'USD', pricingRevision: 'free-v1',
} as const

/**
 * Media-owned policy seams. Both run on the caller's fenced transaction and may
 * never begin, commit or roll back; every failure escapes so the caller rolls
 * back the tool row, reservation, approval, items and events together.
 */
export interface AgentMediaProposalDependencies {
  runtimeLimits(context: AgentToolContext): Promise<GenerationInputLimits>
  /**
   * Reserves quota `estimated_cost` for the new tool call with the given
   * amount/currency/pricingRevision and idempotency key
   * `media-proposal:${toolCallId}:estimated_cost`, on `client`.
   */
  reserveEstimatedCost(client: AgentSqlClient, input: {
    scope: AgentTurnScope; roundId: string; toolCallId: string; amount: string; currency: string
    pricingRevision: string; limit: AgentBudgetDTO; nowMs: number
  }): Promise<{ id: string }>
}

export interface AgentMediaProposalContext {
  readonly scope: AgentTurnScope
  readonly round: { readonly roundId: string; readonly position: number }
  readonly turn: AgentTurnDTO
  readonly signal: AbortSignal
}

export interface AgentMediaProposalInput {
  readonly rawToolCallId: string
  readonly toolName: 'generate_image' | 'generate_video' | 'edit_image'
  readonly toolSchemaVersion: number
  readonly rawArgs: JsonObject
}

export interface MaterializedAgentMediaProposal {
  readonly toolCallId: string
  readonly approvalId: string
  readonly arguments: JsonObject
  readonly argumentsHash: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHECKSUM = /^[0-9a-f]{64}$/
const CANONICAL_KEYS = 'inputBindings,inputs,modelId,modelRevisionId,parameters,pricing,prompt'
const RAW_KEYS = 'inputs,modelId,parameters,prompt'
const RAW_INPUT_KEYS = ['assetId', 'position', 'role', 'uploadId']
const MAX_PARAMETERS = 32
const MAX_INPUTS = 16
const MAX_PROMPT = 16_000

function invalid(): never { throw new MediaServiceError('INVALID_INPUT', '媒体提案无效', 400) }
function object(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value) }

/** Canonical proposals are backend-authored; raw model requests never carry these keys. */
export function isCanonicalMediaProposal(args: JsonObject): boolean {
  if (Object.keys(args).sort().join(',') !== CANONICAL_KEYS) return false
  if (typeof args.modelId !== 'string' || !UUID.test(args.modelId)) return false
  if (typeof args.modelRevisionId !== 'string' || !UUID.test(args.modelRevisionId)) return false
  if (typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > MAX_PROMPT) return false
  if (!object(args.parameters)) return false
  return Array.isArray(args.inputs) && Array.isArray(args.inputBindings) && object(args.pricing)
}

interface RawParameter { name: string; value: string }
interface RawInput { uploadId?: string; assetId?: string; role: string; position: number }
interface RawMediaRequest { modelId: string; prompt: string; parameters: RawParameter[]; inputs: RawInput[] }

/** The frozen model-facing schema: bounded string parameters and managed input references. */
function rawRequest(args: JsonObject): RawMediaRequest {
  if (Object.keys(args).sort().join(',') !== RAW_KEYS) invalid()
  if (typeof args.modelId !== 'string' || !UUID.test(args.modelId)) invalid()
  if (typeof args.prompt !== 'string') invalid()
  const prompt = args.prompt.trim()
  if (!prompt || prompt.length > MAX_PROMPT) invalid()
  if (!Array.isArray(args.parameters) || args.parameters.length > MAX_PARAMETERS) invalid()
  const parameters: RawParameter[] = []
  for (const entry of args.parameters) {
    if (!object(entry) || Object.keys(entry).sort().join(',') !== 'name,value') invalid()
    const { name, value } = entry
    if (typeof name !== 'string' || !name.trim() || name.length > 80) invalid()
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) invalid()
    parameters.push({ name, value })
  }
  if (!Array.isArray(args.inputs) || args.inputs.length > MAX_INPUTS) invalid()
  const inputs: RawInput[] = []
  for (const entry of args.inputs) {
    if (!object(entry) || Object.keys(entry).some(key => !RAW_INPUT_KEYS.includes(key))) invalid()
    const { uploadId, assetId, role, position } = entry
    // Exactly one managed source per input; the model never names a stored checksum.
    if ((uploadId === undefined) === (assetId === undefined)) invalid()
    if (uploadId !== undefined && (typeof uploadId !== 'string' || !UUID.test(uploadId))) invalid()
    if (assetId !== undefined && (typeof assetId !== 'string' || !UUID.test(assetId))) invalid()
    if (typeof role !== 'string' || !role.trim() || role.length > 40) invalid()
    if (!Number.isInteger(position) || (position as number) < 0 || (position as number) > 15) invalid()
    inputs.push({ ...(uploadId === undefined ? { assetId: assetId as string } : { uploadId: uploadId as string }),
      role, position: position as number })
  }
  return { modelId: args.modelId, prompt, parameters, inputs }
}

/**
 * Pinned model row and descriptors, resolved exactly like media-service
 * `prepareGeneration` so both read the same latest revision.
 */
const MODEL_ROW_SQL = `SELECT m.*, rev.id AS revision_id, rev.capabilities, rev.defaults, rev.revision FROM model_configs m
     LEFT JOIN model_config_revisions rev ON rev.id=m.latest_revision_id
     WHERE m.id=$1 AND m.model_kind IN ('image','video') AND m.enabled=true AND m.deleted_at IS NULL`

async function pinnedModel(client: AgentSqlClient, modelId: string): Promise<{
  modelRevisionId: string; parameters: readonly ParameterDescriptor[]
}> {
  const row = (await client.query(MODEL_ROW_SQL, [modelId])).rows[0]
  if (!row) throw new MediaServiceError('MODEL_NOT_AVAILABLE', '模型当前不可用', 409)
  const modelRevisionId = row.revision_id
  if (typeof modelRevisionId !== 'string' || !UUID.test(modelRevisionId)) {
    throw new MediaServiceError('MODEL_NOT_AVAILABLE', '模型当前不可用', 409)
  }
  return { modelRevisionId, parameters: capabilitiesFromRow(row).parameters }
}

/**
 * Raw parameters are bounded strings; the pinned descriptor decides their type.
 * An undeclared name or an unsupported descriptor type fails closed — never drops
 * a parameter the model asked for.
 */
function coerceParameters(raw: RawParameter[], descriptors: readonly ParameterDescriptor[]): Record<string, unknown> {
  const declared = new Map(descriptors.map(descriptor => [descriptor.name, descriptor]))
  const values: Record<string, unknown> = {}
  for (const { name, value } of raw) {
    if (Object.hasOwn(values, name)) invalid()
    const descriptor = declared.get(name)
    if (!descriptor) invalid()
    switch (descriptor.type) {
      case 'integer': {
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed)) invalid()
        values[name] = parsed
        break
      }
      case 'number': {
        const parsed = Number(value)
        if (!Number.isFinite(parsed)) invalid()
        values[name] = parsed
        break
      }
      case 'boolean':
        if (value !== 'true' && value !== 'false') invalid()
        values[name] = value === 'true'
        break
      // `text` is the contract's string descriptor; enum choices and image sizes
      // stay strings and are validated against the pinned descriptor downstream.
      case 'enum':
      case 'image-size':
      case 'text':
        values[name] = value
        break
      default:
        invalid()
    }
  }
  return values
}

function intendedMode(toolName: AgentMediaProposalInput['toolName'], inputs: readonly RawInput[]): GenerationMode {
  if (toolName === 'edit_image') return 'inpaint'
  if (toolName === 'generate_video') return inputs.length ? 'image_to_video' : 'text_to_video'
  return inputs.length ? 'image_to_image' : 'text_to_image'
}

/** Stored, owner-scoped identity of one managed input. Never the checksum the model sent. */
const UPLOAD_ROW_SQL = `SELECT id,checksum FROM media_uploads
  WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL AND object_deleted_at IS NULL`
const ASSET_ROW_SQL = `SELECT id,checksum FROM assets WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL`
const MASK_PREPARATION_SQL = `SELECT p.source_checksum,p.preparation_version FROM agent_media_mask_preparations p
  JOIN media_uploads u ON u.id=p.upload_id AND u.created_by=p.owner_id
  WHERE p.upload_id=$1 AND p.owner_id=$2 AND u.deleted_at IS NULL AND u.object_deleted_at IS NULL`

async function managedInputBindings(client: AgentSqlClient, ownerId: string,
  inputs: readonly { uploadId?: string; assetId?: string; role: string; position: number }[]): Promise<AgentBindingInput[]> {
  const bindings: AgentBindingInput[] = []
  for (const input of inputs) {
    const upload = input.uploadId
    if (upload === undefined && input.assetId === undefined) invalid()
    const id = (upload ?? input.assetId)!
    const row = (await client.query(upload === undefined ? ASSET_ROW_SQL : UPLOAD_ROW_SQL, [id, ownerId])).rows[0]
    if (typeof row?.checksum !== 'string' || !CHECKSUM.test(row.checksum)) invalid()
    const checksum = row.checksum
    if (input.role === 'mask') {
      // A mask is always a prepared upload: the trusted source checksum is the only
      // provenance the approval may bind.
      if (upload === undefined) invalid()
      const preparation = (await client.query(MASK_PREPARATION_SQL, [upload, ownerId])).rows[0]
      const sourceChecksum = preparation?.source_checksum
      if (preparation?.preparation_version !== 1 || typeof sourceChecksum !== 'string' || !CHECKSUM.test(sourceChecksum)) invalid()
      bindings.push({ id, checksum, role: input.role, position: input.position, preparationVersion: 1, sourceChecksum })
    } else {
      bindings.push({ id, checksum, role: input.role, position: input.position })
    }
  }
  return bindings.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
}

/**
 * Materialization never spends through the tool budget port: the only reservation
 * here is the injected free estimated_cost (step 8). Reaching for another quota
 * during materialization would be a policy bug, so the port refuses.
 */
const UNUSED_TOOL_BUDGET: AgentToolBudgetPort = {
  reserve() { return Promise.reject(new Error('AGENT_MEDIA_PROPOSAL_HAS_NO_TOOL_BUDGET')) },
}

/** The frozen media-service row read covers only what `runtimeLimits` may inspect. */
function runtimeContext(client: AgentSqlClient, context: AgentMediaProposalContext, rawToolCallId: string): AgentToolContext {
  return { scope: context.scope, turn: context.turn,
    round: { roundId: context.round.roundId, position: context.round.position, inputRevision: context.turn.inputRevision },
    toolCallId: rawToolCallId, sql: client, budget: UNUSED_TOOL_BUDGET, signal: context.signal }
}

/**
 * The materializer only reserves the free estimated_cost. Paid quotas stay capped
 * by the approved execution path against the Turn's real budget snapshot, so this
 * projection exposes no monetary ceiling (a zero estimate cannot exceed one) and
 * no count headroom.
 */
function proposalBudgetLimit(turn: AgentTurnDTO): AgentBudgetDTO {
  return { maxModelCalls: 0, maxToolCalls: 0, maxMediaJobs: 0, maxMediaOutputs: 0, maxInputTokens: '0',
    maxOutputTokens: '0', maxEstimatedCost: null, maxConcurrentMediaJobs: 0, deadlineAt: turn.deadlineAt }
}

/** The Worker narrows the query surface; both are the caller's fenced pg client. */
const coreClient = (client: AgentSqlClient): AgentCoreClient => client as unknown as AgentCoreClient

/**
 * Turns one raw model media call into the durable, approval-bound canonical
 * proposal: pinned revision, coerced parameters, managed input checksums, free
 * price, estimated-cost reservation, tool-call row and pending approval.
 *
 * Every step runs on `client`, the caller's existing fenced transaction: no
 * BEGIN/COMMIT/ROLLBACK, no provider calls, no partial success.
 */
export async function materializeAgentMediaProposal(client: AgentSqlClient, context: AgentMediaProposalContext,
  input: AgentMediaProposalInput, dependencies: AgentMediaProposalDependencies): Promise<MaterializedAgentMediaProposal> {
  context.signal.throwIfAborted()
  if (typeof input.rawToolCallId !== 'string' || !input.rawToolCallId) invalid()
  if (!['generate_image', 'generate_video', 'edit_image'].includes(input.toolName)) invalid()
  const raw = rawRequest(input.rawArgs)
  const pinned = await pinnedModel(client, raw.modelId)
  const parameters = coerceParameters(raw.parameters, pinned.parameters)
  const prepared = await prepareGeneration({
    ownerId: context.scope.ownerId, modelId: raw.modelId, prompt: raw.prompt, parameters,
    normalizedInputs: raw.inputs, intendedMode: intendedMode(input.toolName, raw.inputs),
    expectedModelRevisionId: pinned.modelRevisionId, idempotencyKey: `agent-proposal:${input.rawToolCallId}`,
  }, {
    database: () => client,
    runtimeLimits: () => dependencies.runtimeLimits(runtimeContext(client, context, input.rawToolCallId)),
  })
  if (prepared.snapshot.mediaKind !== (input.toolName === 'generate_video' ? 'video' : 'image')) invalid()
  const frozen = prepared.snapshot.frozenPayload
  const modelRevisionId = prepared.snapshot.modelRevision.modelRevisionId
  if (typeof modelRevisionId !== 'string' || !UUID.test(modelRevisionId) || modelRevisionId !== pinned.modelRevisionId) {
    throw new MediaServiceError('MODEL_NOT_AVAILABLE', '模型版本已更新，请重新审批', 409)
  }
  const inputBindings = await managedInputBindings(client, context.scope.ownerId, frozen.inputs)
  await lockManagedGenerationInputs(client, prepared, inputBindings)
  const argumentsObject: JsonObject = {
    modelId: frozen.modelId, modelRevisionId, prompt: frozen.prompt, parameters: frozen.parameters,
    inputs: frozen.inputs as unknown as JsonObject, inputBindings: inputBindings as unknown as JsonObject,
    pricing: { ...AGENT_MEDIA_FREE_PRICING },
  }
  const argumentsHash = canvasAgentRequestDigest(argumentsObject)
  // The canonical arguments ARE the approved effect: any drift in defaults,
  // prompt normalisation or managed checksums must fail before any write.
  if (argumentsHash !== generationEffectBindingHash(prepared, inputBindings, AGENT_MEDIA_FREE_PRICING, modelRevisionId)) invalid()
  const toolCall = await appendAgentMediaProposalToolCall(coreClient(client), {
    scope: context.scope, roundId: context.round.roundId, providerCallId: `agent-proposal:${input.rawToolCallId}`,
    toolName: input.toolName, toolSchemaVersion: input.toolSchemaVersion, arguments: argumentsObject,
    argumentsHash, idempotencyKey: `proposal:${input.rawToolCallId}`,
  })
  // The reservation binds the real tool call, so the row must exist first.
  const reservation = await dependencies.reserveEstimatedCost(client, {
    scope: context.scope, roundId: context.round.roundId, toolCallId: toolCall.toolCallId,
    amount: AGENT_MEDIA_FREE_PRICING.amount, currency: AGENT_MEDIA_FREE_PRICING.currency,
    pricingRevision: AGENT_MEDIA_FREE_PRICING.pricingRevision, limit: proposalBudgetLimit(context.turn), nowMs: Date.now(),
  })
  // The approval must name the same frozen language revision the control plane
  // compares at resolution: the Turn's config snapshot, not a DTO projection.
  const frozenRevision = (await client.query(
    `SELECT config_snapshot->>'modelRevisionId' AS model_revision FROM agent_turns WHERE id=$1 AND session_id=$2`,
    [context.scope.turnId, context.scope.sessionId])).rows[0]?.model_revision
  if (typeof frozenRevision !== 'string' || !frozenRevision) invalid()
  const approval = await createPendingAgentMediaApproval(coreClient(client), {
    scope: context.scope, toolCallId: toolCall.toolCallId, argumentsHash, modelRevision: frozenRevision,
    pricingRevision: AGENT_MEDIA_FREE_PRICING.pricingRevision, reservationId: reservation.id,
  })
  context.signal.throwIfAborted()
  return { toolCallId: toolCall.toolCallId, approvalId: approval.approvalId, arguments: argumentsObject, argumentsHash }
}
