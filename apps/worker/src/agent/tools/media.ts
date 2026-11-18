import type { AgentDecimal, JsonObject, ToolExecutionResult, GenerationMode } from '@musecanvas/contracts'
import { canvasAgentRequestDigest, assertAgentMediaApproval, linkAgentMediaJob, AgentMediaError } from '@musecanvas/database'
import {
  prepareGeneration, createGenerationInTransaction, normalizeGenerationInputs, lockManagedGenerationInputs,
  generationEffectBindingHash, MediaServiceError,
  type GenerationInputLimits, type AgentBindingInput, type AgentBindingPrice,
} from '@musecanvas/media-service'
import type { AgentTool, AgentToolContext } from '../ports'
import { isCanonicalMediaProposal } from '../media-proposal'

/**
 * M5/runner supplies this mandatory seam. It must assert the current lease/token,
 * input revision, actor/active Turn/cancel/deadline, the WHOLE persisted round and
 * all gates, and current pricing against the exact durable proposal. Use only
 * context.sql and caller-held locks; never start/commit a transaction here.
 * Repository checks below additionally enforce the actual approved binding.
 */
export interface AgentMediaToolPorts {
  assertEffectAllowed(context: AgentToolContext, binding: {
    argumentsHash: string; modelRevisionId: string; pricing: AgentBindingPrice
  }): Promise<void>
  runtimeLimits(context: AgentToolContext): Promise<GenerationInputLimits>
}
interface MediaProposal {
  modelId: string
  modelRevisionId: string
  prompt: string
  parameters: JsonObject
  inputs: Array<{ uploadId?: string; assetId?: string; role: string; position: number }>
  inputBindings: AgentBindingInput[]
  pricing: AgentBindingPrice
}
/** A raw model request must be materialized and approved before its tool identity is persisted. */
export class AgentMediaApprovalRequiredError extends Error {
  readonly code = 'APPROVAL_REQUIRED'
  constructor() { super('MEDIA_PROPOSAL_APPROVAL_REQUIRED') }
}
function invalid(): never { throw new AgentMediaError('APPROVAL_CONFLICT') }
function object(v: unknown): v is JsonObject { return !!v && typeof v === 'object' && !Array.isArray(v) }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function proposal(args: JsonObject): MediaProposal {
  if (args.modelRevisionId === undefined || args.inputBindings === undefined || args.pricing === undefined) {
    throw new AgentMediaApprovalRequiredError()
  }
  if (Object.keys(args).sort().join(',') !== 'inputBindings,inputs,modelId,modelRevisionId,parameters,pricing,prompt'
    || typeof args.modelId !== 'string' || !uuid.test(args.modelId)
    || typeof args.modelRevisionId !== 'string' || !uuid.test(args.modelRevisionId)
    || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 32000
    || !object(args.parameters) || !Array.isArray(args.inputs) || !Array.isArray(args.inputBindings) || !object(args.pricing)) invalid()
  const pricing = args.pricing
  if (Object.keys(pricing).sort().join(',') !== 'amount,currency,pricingRevision'
    || typeof pricing.amount !== 'string' || !/^(0|[1-9][0-9]{0,20})(\.[0-9]{1,9})?$/.test(pricing.amount)
    || typeof pricing.currency !== 'string' || !pricing.currency.length
    || typeof pricing.pricingRevision !== 'string' || !pricing.pricingRevision.length) invalid()
  for (const item of args.inputBindings) {
    const fields = object(item) ? Object.keys(item).sort().join(',') : ''
    const validFields = fields === 'checksum,id,position,role'
      || fields === 'checksum,id,position,preparationVersion,role,sourceChecksum'
    if (!object(item) || !validFields
      || typeof item.id !== 'string' || !uuid.test(item.id) || typeof item.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(item.checksum)
      || typeof item.role !== 'string' || !Number.isInteger(item.position)
      || (item.role === 'mask' && (item.preparationVersion !== 1 || typeof item.sourceChecksum !== 'string' || !/^[0-9a-f]{64}$/.test(item.sourceChecksum)))
      || (item.role !== 'mask' && fields !== 'checksum,id,position,role')) invalid()
  }
  return { modelId: args.modelId, modelRevisionId: args.modelRevisionId, prompt: args.prompt, parameters: args.parameters,
    inputs: normalizeGenerationInputs(args.inputs), inputBindings: args.inputBindings as unknown as AgentBindingInput[],
    pricing: pricing as unknown as AgentBindingPrice }
}

/** Strict model-facing request. Approval metadata and managed checksums are never model-authored. */
const modelParameters: JsonObject = {
  type: 'object', additionalProperties: false, required: ['modelId', 'prompt', 'parameters', 'inputs'],
  properties: {
    modelId: { type: 'string', format: 'uuid', maxLength: 36 }, prompt: { type: 'string', minLength: 1, maxLength: 16000 },
    // Dynamic provider descriptors cannot safely be represented as an open object.
    // The runner resolves bounded string entries against frozen capabilities.
    parameters: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['name', 'value'],
      properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, value: { type: 'string', minLength: 1, maxLength: 4096 } } } },
    inputs: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['role', 'position'],
      properties: { uploadId: { type: 'string', format: 'uuid', maxLength: 36 }, assetId: { type: 'string', format: 'uuid', maxLength: 36 }, role: { type: 'string', minLength: 1, maxLength: 40 }, position: { type: 'integer', minimum: 0, maximum: 15 } } } },
  },
}

/** Executes an internal, already materialized durable proposal after approval. */
export async function executeApprovedAgentMediaProposal(name: 'generate_image' | 'generate_video' | 'edit_image',
  context: AgentToolContext, args: JsonObject, ports: AgentMediaToolPorts): Promise<ToolExecutionResult> {
  // Do not catch errors after reserves/writes: the runner MUST roll back the
  // entire effect transaction. A failed return here could commit partial work.
  context.signal.throwIfAborted()
  const proposed = proposal(args)
  const argumentsHash = canvasAgentRequestDigest(args)
  const guard = { argumentsHash, modelRevisionId: proposed.modelRevisionId, pricing: proposed.pricing }
  await ports.assertEffectAllowed(context, guard)
  const approval = await assertAgentMediaApproval(context.sql, context.scope, context.toolCallId, context.round.roundId, argumentsHash)
  if (approval.pricingRevision !== proposed.pricing.pricingRevision || approval.currency !== proposed.pricing.currency
    || decimalUnits(approval.amount) !== decimalUnits(proposed.pricing.amount)) invalid()
  const mode: GenerationMode = name === 'edit_image' ? 'inpaint' : name === 'generate_video'
    ? (proposed.inputs.length ? 'image_to_video' : 'text_to_video') : (proposed.inputs.length ? 'image_to_image' : 'text_to_image')
  const limits = await ports.runtimeLimits(context)
  const prepared = await prepareGeneration({ ownerId: context.scope.ownerId, modelId: proposed.modelId,
    prompt: proposed.prompt, parameters: proposed.parameters, normalizedInputs: proposed.inputs,
    intendedMode: mode, expectedModelRevisionId: proposed.modelRevisionId, idempotencyKey: `agent:${context.toolCallId}` },
  { database: () => context.sql, runtimeLimits: async () => limits })
  if (prepared.snapshot.mediaKind !== (name === 'generate_video' ? 'video' : 'image')) invalid()
  if (name === 'edit_image') {
    // Agent v1 requires explicit inpaint declaration, rather than the legacy
    // image_to_image+flag fallback supported by manual calls.
    const capabilities = await context.sql.query(`SELECT capabilities FROM model_config_revisions WHERE id=$1 AND model_id=$2`,
      [proposed.modelRevisionId, proposed.modelId])
    const caps = capabilities.rows[0]?.capabilities
    if (!object(caps) || !Array.isArray(caps.modes) || !caps.modes.includes('inpaint')) invalid()
  }
  // The canonical stored proposal is the binding. Defaults, prompt trimming,
  // input normalization or changed checksums cannot silently amend approval.
  if (generationEffectBindingHash(prepared, proposed.inputBindings, proposed.pricing, proposed.modelRevisionId) !== argumentsHash) invalid()
  const existing = (await context.sql.query(`SELECT id FROM generation_jobs WHERE created_by=$1 AND idempotency_key=$2`,
    [context.scope.ownerId, prepared.command.idempotencyKey])).rows[0]
  await lockManagedGenerationInputs(context.sql, prepared, proposed.inputBindings, existing ? String(existing.id) : undefined)
  const count = Number(prepared.snapshot.normalized.parameters.count ?? 1)
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) invalid()
  for (const [quota, amount] of [['media_jobs', '1'], ['media_outputs', String(count)], ['concurrent_media_jobs', '1']] as const) {
    await context.budget.reserve({ quota, amount: amount as AgentDecimal, idempotencyKey: `media:${context.toolCallId}:${quota}` })
  }
  // Estimated-cost reservation is the existing approval's durable reservation;
  // reserve it idempotently through the owner, never create a second estimate.
  const reservation = await context.sql.query(`SELECT idempotency_key FROM agent_budget_reservations WHERE id=$1`, [approval.reservationId])
  if (typeof reservation.rows[0]?.idempotency_key !== 'string') invalid()
  const reserved = await context.budget.reserve({ quota: 'estimated_cost', amount: proposed.pricing.amount as AgentDecimal,
    currency: proposed.pricing.currency, pricingRevision: proposed.pricing.pricingRevision,
    idempotencyKey: reservation.rows[0].idempotency_key })
  if (reserved.id !== approval.reservationId) invalid()
  context.signal.throwIfAborted()
  await ports.assertEffectAllowed(context, guard)
  await assertAgentMediaApproval(context.sql, context.scope, context.toolCallId, context.round.roundId, argumentsHash, approval)
  const created = await createGenerationInTransaction(context.sql, prepared)
  await linkAgentMediaJob(context.sql, context.scope, context.toolCallId, created.jobId)
  context.signal.throwIfAborted()
  await ports.assertEffectAllowed(context, guard)
  return { kind: 'pending', jobIds: [created.jobId] }
}

/** Model calls only submit raw intent; runner/M5 materializes and approves before effects. */
export function createAgentMediaTools(ports: AgentMediaToolPorts): readonly AgentTool[] {
  if (typeof ports?.assertEffectAllowed !== 'function' || typeof ports.runtimeLimits !== 'function') throw new Error('AGENT_MEDIA_PORTS_REQUIRED')
  return (['generate_image', 'generate_video', 'edit_image'] as const).map(name => ({
    name, schemaVersion: 1,
    description: name === 'edit_image'
      ? 'Inpaint using a managed source image and prepared mask. Raw rectangle/brush staging is unsupported.'
      : `Request ${name === 'generate_video' ? 'video' : 'image'} generation. Approval is required before execution.`,
    parameters: modelParameters, permissions: ['media:create'], execution: 'media_async', approval: 'required',
    budget: { maxMediaJobs: 1, maxMediaOutputs: 32, maxEstimatedCost: null },
    async execute(context: AgentToolContext, args: JsonObject): Promise<ToolExecutionResult> {
      // Only a materialized, approval-bound proposal may reach the effect path; a
      // raw model request stays an inert approval request with no writes.
      if (!isCanonicalMediaProposal(args)) throw new AgentMediaApprovalRequiredError()
      return executeApprovedAgentMediaProposal(name, context, args, ports)
    },
  }))
}

function decimalUnits(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,20})(\.[0-9]{1,9})?$/.test(value)) throw new MediaServiceError('APPROVAL_CONFLICT', '费用绑定无效', 409)
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'))
}
