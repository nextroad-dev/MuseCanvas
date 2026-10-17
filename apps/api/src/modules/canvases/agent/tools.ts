import { buildInpaintPrompt, clampEditSelection, CanvasErrorCode as C, applyCanvasOps, parseCanvasOp, isCanvasUuid, type CanvasOp, type CanvasScene, type JsonObject, type JsonValue } from '@musecanvas/contracts'
import { canvasAgentPendingIdentity } from '@musecanvas/database'
import type { LanguageModelChatTool, LanguageModelChatToolCall } from '@musecanvas/providers'
import type { Actor } from '../../../auth/security'
import { raise } from './config'
import { serializeCanonicalJson } from '@musecanvas/domain'
import { normalizeGenerationInputs } from '../../generation-uploads'
import type { AgentStore, RunContext } from './store'
import { submitPending, type GenerationCreate } from './submit'
import { normalizeSubmissionRequest, supportsSubmissionMode } from './normalization'
import { prepareImageEdit } from '../../image-edit/prepare'

const string = { type: 'string' }, uuid = { type: 'string', format: 'uuid' }, number = { type: 'number' }
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const position = object({ x: number, y: number })
const data = object({ prompt: string, text: string, modelId: uuid, parameters: { type: 'object' }, assetId: uuid, jobId: uuid, sourceNodeId: uuid }, [])
const node = object({ id: uuid, type: { type: 'string', enum: ['prompt', 'image', 'video', 'note'] }, position, size: object({ width: number, height: number }), data }, ['id', 'type', 'position', 'data'])
const inputItem = object({ uploadId: uuid, assetId: uuid, role: string, position: number }, ['role', 'position'])
const selection = object({ x: number, y: number, width: number, height: number }, ['x', 'y', 'width', 'height'])
const schemas: Record<string, Record<string, unknown>> = {
  get_canvas: object({}),
  list_models: object({ mode: { type: 'string', enum: ['text_to_image', 'image_to_image', 'inpaint', 'text_to_video', 'image_to_video'] } }, []),
  add_node: object({ node }), update_node: object({ nodeId: uuid, patch: object({ position, size: object({ width: number, height: number }), data }, []) }),
  remove_node: object({ nodeId: uuid }), connect: object({ edge: object({ id: uuid, source: uuid, target: uuid }) }), disconnect: object({ edgeId: uuid }),
  arrange: object({ positions: { type: 'array', maxItems: 500, items: object({ nodeId: uuid, position }) } }),
  generate_image: object({ prompt: string, modelId: uuid, parameters: { type: 'object' }, inputs: { type: 'array', maxItems: 16, items: inputItem } }, ['prompt', 'modelId']),
  generate_video: object({ sourceNodeId: uuid, prompt: string, modelId: uuid, parameters: { type: 'object' }, inputs: { type: 'array', maxItems: 16, items: inputItem } }, ['prompt', 'modelId']),
  edit_image: object({ prompt: string, modelId: uuid, parameters: { type: 'object' }, sourceNodeId: uuid, sourceAssetId: uuid, selection }, ['prompt', 'modelId', 'selection']),
}
export const agentTools: LanguageModelChatTool[] = Object.entries(schemas).map(([name, parameters]) => ({
  name,
  description: name.startsWith('generate_') || name.startsWith('edit_')
    ? 'Create a persisted pending generation or edit. A pending result ends this round.'
    : 'Read or propose canvas changes; never save the scene.',
  parameters,
}))
export function validateToolArguments(name: string, input: unknown): asserts input is JsonObject {
  const schema = schemas[name]
  if (!schema) raise(C.INVALID_INPUT)
  function validate(value: unknown, schema: any, depth = 0): void {
    if (depth > 12) raise(C.INVALID_INPUT)
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) raise(C.INVALID_INPUT)
      const entries = value as Record<string, unknown>
      for (const key of Reflect.ownKeys(entries)) {
        if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) || !('value' in Object.getOwnPropertyDescriptor(entries, key)!)) raise(C.INVALID_INPUT)
        if (schema.additionalProperties === false && !Object.hasOwn(schema.properties, key)) raise(C.INVALID_INPUT)
        if (schema.properties?.[key]) validate(entries[key], schema.properties[key], depth + 1)
      }
      for (const key of schema.required ?? []) if (!Object.hasOwn(entries, key)) raise(C.INVALID_INPUT)
    } else if (schema.type === 'array') {
      if (!Array.isArray(value) || value.length > schema.maxItems) raise(C.INVALID_INPUT)
      for (const item of value) validate(item, schema.items, depth + 1)
    } else if (schema.type === 'string') {
      if (typeof value !== 'string' || value.length > 16000 || (schema.format === 'uuid' && !isCanvasUuid(value))) raise(C.INVALID_INPUT)
    } else if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) raise(C.INVALID_INPUT)
    if (schema.enum && !schema.enum.includes(value)) raise(C.INVALID_INPUT)
  }
  validate(input, schema)
}
function summaryText(value: string): string {
  const text = value.slice(0, 500)
  // A length bound must not split an otherwise valid surrogate pair.
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text
}
export function canvasSummary(scene: CanvasScene): JsonValue {
  return { nodeCount: scene.nodes.length, edgeCount: scene.edges.length, nodes: scene.nodes.slice(0, 50).map(node => ({ id: node.id, type: node.type, position: node.position,
    data: Object.fromEntries(Object.entries(node.data).map(([key, value]) => [key, typeof value === 'string' ? summaryText(value) : key === 'parameters' ? {} : value])) })) as unknown as JsonValue,
    edges: scene.edges.slice(0, 100) as unknown as JsonValue }
}
function assertExplicitParameters(parameters: JsonObject, explicit?: JsonObject, derived: string[] = []): void {
  for (const [key, value] of Object.entries(explicit ?? {})) {
    if (!derived.includes(key) && serializeCanonicalJson(parameters[key]) !== serializeCanonicalJson(value)) raise(C.INVALID_INPUT)
  }
}
export interface ToolOutcome { result: JsonValue; ops: CanvasOp[]; pending?: import('@musecanvas/database').CanvasAgentPendingJob }
export async function executeTool(input: { store: AgentStore; ctx: RunContext; actor: Actor; call: LanguageModelChatToolCall; scene: CanvasScene; signal: AbortSignal; create: GenerationCreate; prepare?: typeof prepareImageEdit }): Promise<ToolOutcome> {
  const { store, ctx, actor, call, scene, signal, create } = input
  if (signal.aborted) raise(C.CANVAS_AGENT_CANCELED, 409)
  validateToolArguments(call.name, call.arguments)
  const args: JsonObject = { ...call.arguments as JsonObject }
  const explicit = ctx.context
  const generationTool = call.name.startsWith('generate_') || call.name === 'edit_image'
  if (generationTool && explicit) {
    const editing = call.name === 'edit_image'
    if ((explicit.intent === 'edit' || explicit.editSource) && !editing) raise(C.INVALID_INPUT)
    if (explicit.intent === 'generate' && editing) raise(C.INVALID_INPUT)
    if (explicit.modelId) {
      if (args.modelId !== explicit.modelId) raise(C.INVALID_INPUT)
      args.modelId = explicit.modelId
    }
    const parameters = { ...(args.parameters ?? {}) as JsonObject }
    for (const [key, value] of Object.entries(explicit.parameters ?? {})) {
      if (Object.hasOwn(parameters, key) && serializeCanonicalJson(parameters[key]) !== serializeCanonicalJson(value)) raise(C.INVALID_INPUT)
      parameters[key] = value
    }
    args.parameters = parameters
    if (explicit.inputs !== undefined) {
      const inputs = normalizeGenerationInputs(explicit.inputs)
      if (args.inputs !== undefined && serializeCanonicalJson(normalizeGenerationInputs(args.inputs)) !== serializeCanonicalJson(inputs)) raise(C.INVALID_INPUT)
      if (editing && inputs.length) raise(C.INVALID_INPUT) // edit prepares its own frozen reference/mask pair
      args.inputs = inputs as unknown as JsonValue
    }
    if (editing && explicit.editSource) {
      const source = explicit.editSource
      for (const [key, value] of Object.entries({ sourceAssetId: source.assetId, sourceNodeId: source.nodeId, selection: source.selection })) {
        if (value === undefined) continue
        if (args[key] !== undefined && serializeCanonicalJson(args[key]) !== serializeCanonicalJson(value)) raise(C.INVALID_INPUT)
        args[key] = value as JsonValue
      }
    }
  }
  if (call.name === 'get_canvas') return { result: canvasSummary(scene), ops: [] }
  if (call.name === 'list_models') return { result: await store.models(args.mode as string | undefined), ops: [] }
  if (!call.name.startsWith('generate_') && call.name !== 'edit_image') {
    const parsed = parseCanvasOp({ type: call.name, ...args })
    if (!parsed.success) raise(parsed.error.code)
    const applied = applyCanvasOps(scene, [parsed.data])
    if (!applied.success) raise(applied.error.code)
    await store.validateReferences(ctx, [parsed.data], scene)
    return { result: { ok: true }, ops: [parsed.data] }
  }

  const namespacedCallId = `${ctx.lease.turnId}:${call.id}`
  const existing = await store.existingPending(ctx, namespacedCallId)
  if (call.name === 'edit_image') {
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) raise(C.INVALID_INPUT)
    let sourceAssetId = args.sourceAssetId as string | undefined
    const sourceNodeId = args.sourceNodeId as string | undefined
    if (sourceNodeId) {
      const ownedSource = await store.source(actor.id, ctx.scope.canvasId, sourceNodeId)
      if (sourceAssetId && sourceAssetId !== ownedSource) raise(C.INVALID_INPUT)
      sourceAssetId = ownedSource
    }
    if (!sourceAssetId) raise(C.SOURCE_NOT_READY, 409)

    const model = await store.mediaModel(args.modelId as string, 'image')
    if (!supportsSubmissionMode(model.capabilities, 'inpaint')) raise(C.INVALID_INPUT)
    if (existing) {
      const metadata = existing.editMetadata
      const selected = metadata && clampEditSelection(args.selection as any, metadata.sourceWidth, metadata.sourceHeight)
      if (!metadata || !selected || existing.modelConfigDigest !== model.digest || existing.modelId !== args.modelId
        || existing.sourceAssetId !== sourceAssetId || existing.sourceNodeId !== (sourceNodeId ?? null)
        || existing.prompt !== buildInpaintPrompt(args.prompt as string)
        || serializeCanonicalJson(selected) !== serializeCanonicalJson(metadata.selection)) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      const normalized = normalizeSubmissionRequest({ capabilities: model.capabilities, defaults: model.defaults as Record<string, JsonValue>,
        request: { modelId: existing.modelId, prompt: existing.prompt, parameters: { ...(args.parameters ?? {}) as JsonObject, size: existing.parameters.size!, count: 1 }, inputs: existing.normalizedInputs ?? [] },
        kind: 'image', signal, deadline: ctx.deadline })
      const frozen = { modelId: normalized.modelId, prompt: normalized.prompt, parameters: normalized.parameters, mode: normalized.mode, inputs: normalized.inputs }
      if (serializeCanonicalJson(frozen) !== serializeCanonicalJson(existing.normalizedRequest)) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
      return { pending: existing, result: { pendingId: existing.id, status: existing.status, confirmationRequired: true }, ops: existing.status === 'submitted' ? existing.ops : [] }
    }
    let preparation = await store.reserveEdit(ctx, namespacedCallId, {
      modelId: args.modelId as string, modelConfigDigest: model.digest, prompt: (args.prompt as string).trim(), parameters: (args.parameters ?? {}) as JsonObject,
      sourceAssetId, sourceNodeId: sourceNodeId ?? null, selection: args.selection!,
    })
    if (preparation.status !== 'ready') {
      const prepared = await (input.prepare ?? prepareImageEdit)({ actor, modelId: args.modelId as string, prompt: args.prompt as string,
        parameters: (args.parameters ?? {}) as Record<string, unknown>, assetId: sourceAssetId, selection: args.selection as any,
        reservedMask: { uploadId: preparation.maskUploadId, expiresAt: preparation.expiresAt,
          persist: (row, put) => store.stageEditMask(ctx, preparation, row, put) } })
      if (!prepared.success || !prepared.data.selection) raise(C.INVALID_INPUT)
      const normalized = normalizeSubmissionRequest({ capabilities: model.capabilities, defaults: model.defaults as Record<string, JsonValue>,
        request: { modelId: args.modelId as string, prompt: prepared.data.prompt, parameters: prepared.data.parameters as JsonObject, inputs: prepared.data.inputs },
        kind: 'image', signal, deadline: ctx.deadline })
      if (normalized.parameters.count !== 1 || normalized.parameters.size !== prepared.data.parameters.size) raise(C.INVALID_INPUT)
      assertExplicitParameters(normalized.parameters, explicit?.parameters, ['size', 'count'])
      preparation = await store.completeEdit(ctx, preparation, { normalizedRequest: { modelId: normalized.modelId, prompt: normalized.prompt, parameters: normalized.parameters,
        mode: normalized.mode, inputs: normalized.inputs as unknown as JsonValue },
        editMetadata: { selection: prepared.data.selection, sourceWidth: prepared.data.source.width, sourceHeight: prepared.data.source.height } })
    }
    const frozen = preparation.readySnapshot!
    const normalizedRequest = frozen.normalizedRequest
    const ids = canvasAgentPendingIdentity(ctx.scope.canvasId, namespacedCallId)
    const sourceNode = sourceNodeId ? scene.nodes.find(n => n.id === sourceNodeId) : null
    const ops: CanvasOp[] = [{ type: 'add_node', node: { id: ids.nodeId, type: 'image',
      position: { x: (sourceNode?.position.x ?? 0) + 320, y: sourceNode?.position.y ?? 0 },
      data: { prompt: normalizedRequest.prompt as string, modelId: args.modelId as string, parameters: normalizedRequest.parameters as JsonObject,
        ...(sourceNodeId ? { sourceNodeId } : {}) } } }]
    if (sourceNodeId) ops.push({ type: 'connect', edge: { id: ids.edgeId, source: sourceNodeId, target: ids.nodeId } })
    const applied = applyCanvasOps(scene, ops)
    if (!applied.success) raise(applied.error.code)

    const pending = await store.pending(ctx, {
      toolCallId: namespacedCallId,
      kind: 'image',
      prompt: normalizedRequest.prompt as string,
      modelId: args.modelId as string,
      parameters: normalizedRequest.parameters as JsonObject,
      sourceNodeId: sourceNodeId ?? null,
      sourceAssetId,
      baseRevision: ctx.canvas.revision,
      expiresAt: preparation.expiresAt,
      ops,
      modelConfigDigest: model.digest,
      editMetadata: frozen.editMetadata,
      requestVersion: 2,
      normalizedRequest,
      normalizedInputs: normalizedRequest.inputs as any,
    })

    if (ctx.requireConfirmation || ctx.context || ctx.requestSnapshot?.sceneCommitMode === 'agent-managed') return { pending, result: { pendingId: pending.id, status: pending.status, confirmationRequired: true }, ops: [] }
    if (signal.aborted) raise(C.CANVAS_AGENT_CANCELED, 409)
    const submitted = await submitPending(store, actor, ctx.scope.canvasId, { pendingId: pending.id, approve: true }, create, signal, ctx.settings.timeoutMs)
    return { pending: submitted, result: { pendingId: submitted.id, jobId: submitted.jobId, status: submitted.status }, ops: submitted.ops }
  }

  const kind = call.name === 'generate_image' ? 'image' : 'video'
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) raise(C.INVALID_INPUT)

  let rawInputs: Array<{ uploadId?: string; assetId?: string; role: string; position: number }> = []
  if (args.inputs !== undefined) {
    rawInputs = normalizeGenerationInputs(args.inputs)
  } else if (kind === 'video' && args.sourceNodeId) {
    const sourceAssetId = await store.source(actor.id, ctx.scope.canvasId, args.sourceNodeId as string)
    rawInputs = [{ assetId: sourceAssetId, role: 'first_frame', position: 0 }]
  }

  if (args.sourceNodeId && args.inputs !== undefined) {
    const source = await store.source(actor.id, ctx.scope.canvasId, args.sourceNodeId as string)
    if (!rawInputs.some(item => item.assetId === source && item.role === 'first_frame')) raise(C.INVALID_INPUT)
  }
  const model = await store.mediaModel(args.modelId as string, kind)
  const request = {
    modelId: args.modelId as string,
    prompt: args.prompt as string,
    parameters: (args.parameters ?? {}) as JsonObject,
    inputs: rawInputs,
    idempotencyKey: 'agent-validation',
  }
  const normalized = normalizeSubmissionRequest({
    capabilities: model.capabilities,
    defaults: model.defaults as Record<string, JsonValue>,
    request,
    kind,
    signal,
    deadline: ctx.deadline,
  })

  assertExplicitParameters(normalized.parameters, explicit?.parameters)
  const sourceNodeId = (args.sourceNodeId as string | undefined) ?? (
    rawInputs[0]?.assetId
      ? scene.nodes.find(n => (n.type === 'image' || n.type === 'video') && n.data.assetId === rawInputs[0]?.assetId)?.id ?? null
      : null
  )
  const sourceAssetId = rawInputs[0]?.assetId ?? null

  const ids = canvasAgentPendingIdentity(ctx.scope.canvasId, namespacedCallId)
  const sourceNode = sourceNodeId ? scene.nodes.find(n => n.id === sourceNodeId) : null

  const ops: CanvasOp[] = [{
    type: 'add_node',
    node: {
      id: ids.nodeId,
      type: kind,
      position: { x: (sourceNode?.position.x ?? 0) + 320, y: sourceNode?.position.y ?? 0 },
      data: {
        prompt: normalized.prompt,
        modelId: args.modelId as string,
        parameters: normalized.parameters as JsonObject,
        ...(sourceNodeId ? { sourceNodeId } : {}),
      },
    },
  }]
  if (sourceNodeId) ops.push({ type: 'connect', edge: { id: ids.edgeId, source: sourceNodeId, target: ids.nodeId } })

  const applied = applyCanvasOps(scene, ops)
  if (!applied.success) raise(applied.error.code)

  const normalizedRequest: JsonObject = {
    modelId: normalized.modelId,
    prompt: normalized.prompt,
    parameters: normalized.parameters,
    mode: normalized.mode,
    inputs: normalized.inputs as unknown as JsonValue,
  }

  if (existing) {
    if (existing.modelConfigDigest !== model.digest || serializeCanonicalJson(existing.normalizedRequest) !== serializeCanonicalJson(normalizedRequest)
      || existing.sourceNodeId !== sourceNodeId || existing.sourceAssetId !== sourceAssetId) raise(C.CANVAS_AGENT_CONFIRM_CONFLICT, 409)
    return { pending: existing, result: { pendingId: existing.id, status: existing.status, confirmationRequired: true }, ops: existing.status === 'submitted' ? existing.ops : [] }
  }
  const pending = await store.pending(ctx, {
    toolCallId: namespacedCallId,
    kind,
    prompt: normalized.prompt,
    modelId: args.modelId as string,
    parameters: normalized.parameters as JsonObject,
    sourceNodeId,
    sourceAssetId,
    baseRevision: ctx.canvas.revision,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    ops,
    modelConfigDigest: model.digest,
    requestVersion: 2,
    normalizedRequest,
    normalizedInputs: normalized.inputs,
  })

  if (ctx.requireConfirmation || ctx.context || ctx.requestSnapshot?.sceneCommitMode === 'agent-managed') return { pending, result: { pendingId: pending.id, status: pending.status, confirmationRequired: true }, ops: [] }
  if (signal.aborted) raise(C.CANVAS_AGENT_CANCELED, 409)
  const submitted = await submitPending(store, actor, ctx.scope.canvasId, { pendingId: pending.id, approve: true }, create, signal, ctx.settings.timeoutMs)
  return { pending: submitted, result: { pendingId: submitted.id, jobId: submitted.jobId, status: submitted.status }, ops: submitted.ops }
}
