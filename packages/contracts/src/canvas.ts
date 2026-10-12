import type { JsonObject, JsonValue, GenerationMode } from './index'

export const CANVAS_MAX_SCENE_BYTES = 512 * 1024
export const CANVAS_MAX_NODES = 500
export const CANVAS_MAX_EDGES = 1000
export const CANVAS_MAX_TITLE_LENGTH = 120
export const CANVAS_DEFAULT_TITLE = '未命名画布'
export const CANVAS_MAX_TEXT_LENGTH = 16_000
export const CANVAS_MAX_PARAMETERS_BYTES = 32 * 1024
export const CANVAS_MAX_PARAMETERS_DEPTH = 8
export const CANVAS_MAX_JSON_VALUES = 4096
export const CANVAS_MAX_OPS = 1000
export const CANVAS_AGENT_DEFAULT_REQUIRE_CONFIRMATION = true
export const CANVAS_AGENT_SETTINGS_DEFAULTS = {
  enabled: false,
  languageModelConfigId: null,
  maxToolCallsPerTurn: 12,
  maxJobsPerTurn: 4,
  timeoutMs: 120_000,
  maxAutoContinuations: 3,
} as const

export const CanvasErrorCode = {
  INVALID_INPUT: 'INVALID_INPUT',
  CANVAS_NOT_FOUND: 'CANVAS_NOT_FOUND',
  CANVAS_REVISION_CONFLICT: 'CANVAS_REVISION_CONFLICT',
  CANVAS_SCENE_TOO_LARGE: 'CANVAS_SCENE_TOO_LARGE',
  CANVAS_NODE_LIMIT_EXCEEDED: 'CANVAS_NODE_LIMIT_EXCEEDED',
  CANVAS_EDGE_LIMIT_EXCEEDED: 'CANVAS_EDGE_LIMIT_EXCEEDED',
  CANVAS_NODE_NOT_FOUND: 'CANVAS_NODE_NOT_FOUND',
  CANVAS_EDGE_NOT_FOUND: 'CANVAS_EDGE_NOT_FOUND',
  CANVAS_DUPLICATE_NODE_ID: 'CANVAS_DUPLICATE_NODE_ID',
  CANVAS_DUPLICATE_EDGE_ID: 'CANVAS_DUPLICATE_EDGE_ID',
  CANVAS_DANGLING_REFERENCE: 'CANVAS_DANGLING_REFERENCE',
  CANVAS_AGENT_DISABLED: 'CANVAS_AGENT_DISABLED',
  CANVAS_AGENT_NOT_CONFIGURED: 'CANVAS_AGENT_NOT_CONFIGURED',
  CANVAS_AGENT_MODEL_UNSUPPORTED: 'CANVAS_AGENT_MODEL_UNSUPPORTED',
  CANVAS_AGENT_BUSY: 'CANVAS_AGENT_BUSY',
  CANVAS_AGENT_BUDGET_EXCEEDED: 'CANVAS_AGENT_BUDGET_EXCEEDED',
  CANVAS_AGENT_AUTO_CONTINUATION_LIMIT: 'CANVAS_AGENT_AUTO_CONTINUATION_LIMIT',
  CANVAS_AGENT_TIMEOUT: 'CANVAS_AGENT_TIMEOUT',
  CANVAS_AGENT_CANCELED: 'CANVAS_AGENT_CANCELED',
  CANVAS_AGENT_FAILED: 'CANVAS_AGENT_FAILED',
  CANVAS_AGENT_RATE_LIMITED: 'CANVAS_AGENT_RATE_LIMITED',
  CANVAS_AGENT_MESSAGE_CONFLICT: 'CANVAS_AGENT_MESSAGE_CONFLICT',
  CANVAS_AGENT_CONFIRM_NOT_FOUND: 'CANVAS_AGENT_CONFIRM_NOT_FOUND',
  CANVAS_AGENT_CONFIRM_EXPIRED: 'CANVAS_AGENT_CONFIRM_EXPIRED',
  CANVAS_AGENT_CONFIRM_CONFLICT: 'CANVAS_AGENT_CONFIRM_CONFLICT',
  CANVAS_AGENT_APPLY_CONFLICT: 'CANVAS_AGENT_APPLY_CONFLICT',
  SOURCE_NOT_READY: 'SOURCE_NOT_READY',
} as const
export type CanvasErrorCode = (typeof CanvasErrorCode)[keyof typeof CanvasErrorCode]
export interface CanvasValidationError { code: CanvasErrorCode; message: string; path: string }
export type CanvasParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: CanvasValidationError }

export interface CanvasPosition { x: number; y: number }
export interface CanvasSize { width: number; height: number }
export interface CanvasPromptData { prompt: string; modelId?: string; parameters?: JsonObject }
export interface CanvasMediaData {
  assetId?: string
  jobId?: string
  sourceNodeId?: string
  prompt?: string
  modelId?: string
  parameters?: JsonObject
}
export interface CanvasNoteData { text: string }
interface CanvasNodeBase { id: string; position: CanvasPosition; size?: CanvasSize }
export type CanvasNode = CanvasNodeBase & (
  | { type: 'prompt'; data: CanvasPromptData }
  | { type: 'image'; data: CanvasMediaData }
  | { type: 'video'; data: CanvasMediaData }
  | { type: 'note'; data: CanvasNoteData }
)
export type CanvasNodeType = CanvasNode['type']
export interface CanvasEdge { id: string; source: string; target: string }
export interface CanvasScene { nodes: CanvasNode[]; edges: CanvasEdge[] }
export interface CanvasListItemDto {
  id: string
  title: string
  revision: number
  coverAssetId: string | null
  createdAt: string
  updatedAt: string
}
export interface CanvasDto extends CanvasListItemDto { scene: CanvasScene }
export interface CanvasListPageDto { items: CanvasListItemDto[]; nextCursor: string | null }
export interface CreateCanvasRequest { title?: string; scene?: CanvasScene; coverAssetId?: string | null }
export interface ParsedCreateCanvasRequest { title: string; scene: CanvasScene; coverAssetId: string | null }
export interface UpdateCanvasRequest extends CreateCanvasRequest { baseRevision: number }

/** Data patches merge fields; parameters replace the complete parameter object.
 * The target node's discriminator is authoritative and validated by applyCanvasOps.
 * References are optional UUIDs, not URLs or null; remove_node clears source refs. */
export type CanvasNodeDataPatch = Partial<CanvasPromptData & CanvasMediaData & CanvasNoteData>
export interface CanvasNodePatch { position?: CanvasPosition; size?: CanvasSize; data?: CanvasNodeDataPatch }
export type CanvasOp =
  | { type: 'add_node'; node: CanvasNode }
  | { type: 'update_node'; nodeId: string; patch: CanvasNodePatch }
  | { type: 'remove_node'; nodeId: string }
  | { type: 'connect'; edge: CanvasEdge }
  | { type: 'disconnect'; edgeId: string }
  | { type: 'arrange'; positions: { nodeId: string; position: CanvasPosition }[] }

export type CanvasAgentSceneCommitMode = 'client-managed' | 'agent-managed'

export interface CanvasAgentEditSelection {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Actual prepared pixels, not the original un-clamped request rectangle. */
export interface CanvasAgentEditMetadata {
  readonly selection: CanvasAgentEditSelection
  readonly sourceWidth: number
  readonly sourceHeight: number
}
export interface CanvasAgentStructuredInputItem {
  readonly uploadId?: string
  readonly assetId?: string
  readonly role: string
  readonly position: number
}

export interface CanvasAgentStructuredEditSource {
  readonly assetId?: string
  readonly nodeId?: string
  readonly selection: CanvasAgentEditSelection
}

export interface CanvasAgentStructuredContext {
  readonly intent?: 'generate' | 'edit' | 'continue'
  readonly modelId?: string
  readonly parameters?: JsonObject
  readonly inputs?: CanvasAgentStructuredInputItem[]
  readonly editSource?: CanvasAgentStructuredEditSource
}

export type CanvasAgentMessageRequest =
  | {
      kind: 'user'
      messageId: string
      text: string
      baseRevision: number
      requireConfirmation?: boolean
      sceneCommitMode?: CanvasAgentSceneCommitMode
      context?: CanvasAgentStructuredContext
    }
  | {
      kind: 'job_event'
      messageId: string
      jobId: string
      baseRevision: number
      sceneCommitMode?: CanvasAgentSceneCommitMode
    }
export interface CanvasAgentConfirmRequest { pendingId: string; approve: boolean }
export type CanvasAgentPendingStatus = 'pending' | 'submitting' | 'submitted' | 'rejected' | 'expired'
/** Generation inputs are immutable after creation; only status/jobId may advance.
 * stable id + toolCallId support server-side idempotency. No credentials/URLs. */
export interface CanvasAgentPendingJobDto {
  readonly id: string
  readonly toolCallId: string
  readonly kind: 'image' | 'video'
  readonly prompt: string
  readonly modelId: string
  readonly parameters: JsonObject
  readonly sourceNodeId: string | null
  readonly sourceAssetId: string | null
  readonly createdAt: string
  readonly expiresAt: string
  status: CanvasAgentPendingStatus
  jobId: string | null
  readonly turnId?: string | null
  readonly baseRevision?: number
  readonly mode?: GenerationMode
  readonly editMetadata?: CanvasAgentEditMetadata
  readonly requestVersion?: number
  readonly normalizedInputs?: Array<{
    readonly uploadId?: string
    readonly assetId?: string
    readonly role: string
    readonly position: number
  }>
}
export interface CanvasAgentConfirmResultDto { pending: CanvasAgentPendingJobDto; ops: CanvasOp[]; jobId: string | null }
export interface CanvasAgentToolCallDto { id: string; name: string; arguments: JsonObject }
export interface CanvasAgentUsageDto { inputTokens: number; outputTokens: number }
export interface AgentMessageDto {
  id: string
  seq: number
  turnId?: string | null
  contextSummary?: CanvasAgentStructuredContext
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: CanvasAgentToolCallDto[]
  ops?: CanvasOp[]
  usage?: CanvasAgentUsageDto
  createdAt: string
}
/** Messages are ordered by ascending seq; system summaries are stored as user.
 * Auto events resolve job state on the server, never from client claims. */
export interface CanvasAgentHistoryDto {
  sessionId: string
  messages: AgentMessageDto[]
  pendingJobs: CanvasAgentPendingJobDto[]
  requireConfirmation: boolean
  autoContinuationCount: number
  nextAfterSeq: number | null
  nextBeforeSeq?: number | null
}
/** Safe owner-only recovery. Legacy/invalid snapshots are never reconstructed. */
export interface CanvasAgentTurnRecoveryDto {
  turnId: string
  messageId: string
  status: 'running' | 'completed' | 'failed' | 'canceled' | 'expired'
  requestSnapshot: CanvasAgentMessageRequest | null
  legacySnapshotUnavailable: boolean
  sceneCommitRevision: number | null
  sceneCommitAt: string | null
  pendingJobs: CanvasAgentPendingJobDto[]
}
export interface CanvasAgentStatusDto {
  enabled: boolean
  available: boolean
  reason: 'ready' | 'disabled' | 'not_configured' | 'model_unsupported'
  maxToolCallsPerTurn: number
  maxJobsPerTurn: number
  timeoutMs: number
  maxAutoContinuations: number
}
export interface CanvasAgentApplyRequest { turnId: string }
export interface CanvasAgentApplyResultDto {
  applied: boolean
  revision: number
  ops: CanvasOp[]
}
export interface CanvasAgentSettingsDto {
  enabled: boolean
  languageModelConfigId: string | null
  maxToolCallsPerTurn: number
  maxJobsPerTurn: number
  timeoutMs: number
  maxAutoContinuations: number
  updatedAt: string
}
export type UpdateCanvasAgentSettingsRequest = Partial<Omit<CanvasAgentSettingsDto, 'updatedAt'>>
interface CanvasAgentEventBase { turnId: string; eventId: string }
/** SSE `event:` equals type; `data:` is JSON of the entire event (including IDs).
 * Event IDs are server-assigned stable identifiers, not an implicit replay API. */
export type AgentStreamEvent = CanvasAgentEventBase & (
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; toolCall: CanvasAgentToolCallDto }
  | { type: 'tool_result'; toolCallId: string; result: JsonValue; success: boolean }
  | { type: 'canvas_ops'; ops: CanvasOp[]; baseRevision: number }
  | { type: 'pending_jobs'; pendingJobs: CanvasAgentPendingJobDto[] }
  | { type: 'confirm_required'; pending: CanvasAgentPendingJobDto }
  | { type: 'done'; message: AgentMessageDto; usage: CanvasAgentUsageDto; requireConfirmation: boolean; autoContinuationCount: number }
  | { type: 'error'; code: CanvasErrorCode; message: string; retryable: boolean }
)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
export function isCanvasUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}
class ValidationFailure extends Error {
  constructor(readonly detail: CanvasValidationError) { super(detail.message) }
}
function invalid(path: string, message: string, code: CanvasErrorCode = CanvasErrorCode.INVALID_INPUT): never {
  throw new ValidationFailure({ code, message, path })
}
function result<T>(parse: () => T): CanvasParseResult<T> {
  try { return { success: true, data: parse() } } catch (error) {
    return { success: false, error: error instanceof ValidationFailure
      ? error.detail : { code: CanvasErrorCode.INVALID_INPUT, message: 'Invalid input', path: '$' } }
  }
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(path, 'Expected object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(path, 'Expected plain object')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key) || !isCanvasStorageString(key)) invalid(path, 'Forbidden object key')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!descriptor.enumerable || !('value' in descriptor)) invalid(path, 'Expected JSON property')
  }
  return value as Record<string, unknown>
}
function strict(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  const obj = object(value, path)
  for (const key of Object.keys(obj)) if (!keys.includes(key)) invalid(`${path}.${key}`, 'Unknown field')
  return obj
}
function uuid(value: unknown, path: string): string {
  if (!isCanvasUuid(value)) invalid(path, 'Expected UUID')
  return value.toLowerCase()
}
function integer(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(path, `Expected integer ${min}..${max}`)
  return value
}
function revision(value: unknown, path: string): number { return integer(value, 1, Number.MAX_SAFE_INTEGER, path) }
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'Expected boolean')
  return value
}
/** PostgreSQL text/jsonb cannot represent NUL or unpaired UTF-16 surrogates. */
export function isCanvasStorageString(value: string): boolean {
  return !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
}
function text(value: unknown, path: string, nonempty = false): string {
  if (typeof value !== 'string' || !isCanvasStorageString(value) || value.length > CANVAS_MAX_TEXT_LENGTH || (nonempty && !value.trim())) invalid(path, 'Invalid text')
  return value
}
function title(value: unknown, path: string): string {
  if (typeof value !== 'string' || !isCanvasStorageString(value)) invalid(path, 'Expected valid title')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > CANVAS_MAX_TITLE_LENGTH) invalid(path, 'Title must be 1..120 characters')
  return trimmed
}
function bytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength }
function array(value: unknown, max: number, path: string, code: CanvasErrorCode = CanvasErrorCode.INVALID_INPUT): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(path, 'Expected plain array')
  if (value.length > max) invalid(path, 'Too many items', code)
  // Sparse arrays, custom properties and accessors are not JSON arrays.
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1) invalid(path, 'Invalid array properties')
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid(path, 'Invalid array item')
  }
  return value
}
function parameters(value: unknown, path: string): JsonObject {
  let count = 0
  const ancestors = new Set<object>()
  function visit(input: unknown, depth: number, at: string): JsonValue {
    if (++count > CANVAS_MAX_JSON_VALUES || depth > CANVAS_MAX_PARAMETERS_DEPTH) invalid(at, 'Parameters exceed complexity limit')
    if (typeof input === 'string') {
      if (!isCanvasStorageString(input)) invalid(at, 'String cannot be stored')
      return input
    }
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (typeof input !== 'object' || input === null) invalid(at, 'Expected JSON-safe value')
    if (ancestors.has(input)) invalid(at, 'Cyclic parameters')
    ancestors.add(input)
    let output: JsonValue
    if (Array.isArray(input)) {
      output = array(input, CANVAS_MAX_JSON_VALUES, at).map((item, i) => visit(item, depth + 1, `${at}[${i}]`))
    } else {
      output = {}
      for (const [key, item] of Object.entries(object(input, at))) output[key] = visit(item, depth + 1, `${at}.${key}`)
    }
    ancestors.delete(input)
    return output
  }
  object(value, path)
  const parsed = visit(value, 0, path) as JsonObject
  if (bytes(parsed) > CANVAS_MAX_PARAMETERS_BYTES) invalid(path, 'Parameters too large')
  return parsed
}
function position(value: unknown, path: string): CanvasPosition {
  const obj = strict(value, ['x', 'y'], path)
  for (const key of ['x', 'y']) if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key])) invalid(`${path}.${key}`, 'Expected finite coordinate')
  return { x: obj.x as number, y: obj.y as number }
}
function size(value: unknown, path: string): CanvasSize {
  const obj = strict(value, ['width', 'height'], path)
  for (const key of ['width', 'height']) if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key]) || (obj[key] as number) <= 0) invalid(`${path}.${key}`, 'Expected positive finite size')
  return { width: obj.width as number, height: obj.height as number }
}
const DATA_KEYS = ['prompt', 'modelId', 'parameters', 'assetId', 'jobId', 'sourceNodeId', 'text'] as const
function dataFields(value: unknown, keys: readonly string[], path: string): CanvasNodeDataPatch {
  const obj = strict(value, keys, path)
  const output: CanvasNodeDataPatch = {}
  for (const key of ['prompt', 'text'] as const) if (key in obj) output[key] = text(obj[key], `${path}.${key}`)
  for (const key of ['modelId', 'assetId', 'jobId', 'sourceNodeId'] as const) if (key in obj) output[key] = uuid(obj[key], `${path}.${key}`)
  if ('parameters' in obj) output.parameters = parameters(obj.parameters, `${path}.parameters`)
  return output
}
function node(value: unknown, path: string): CanvasNode {
  const obj = strict(value, ['id', 'type', 'position', 'size', 'data'], path)
  const base: CanvasNodeBase = { id: uuid(obj.id, `${path}.id`), position: position(obj.position, `${path}.position`) }
  if ('size' in obj) base.size = size(obj.size, `${path}.size`)
  if (obj.type === 'prompt') {
    const data = dataFields(obj.data, ['prompt', 'modelId', 'parameters'], `${path}.data`)
    if (data.prompt === undefined) invalid(`${path}.data.prompt`, 'Prompt required')
    return { ...base, type: 'prompt', data: data as CanvasPromptData }
  }
  if (obj.type === 'note') {
    const data = dataFields(obj.data, ['text'], `${path}.data`)
    if (data.text === undefined) invalid(`${path}.data.text`, 'Text required')
    return { ...base, type: 'note', data: data as CanvasNoteData }
  }
  if (obj.type === 'image' || obj.type === 'video') return { ...base, type: obj.type, data: dataFields(obj.data, DATA_KEYS.filter(key => key !== 'text'), `${path}.data`) }
  return invalid(`${path}.type`, 'Unknown node type')
}
function edge(value: unknown, path: string): CanvasEdge {
  const obj = strict(value, ['id', 'source', 'target'], path)
  return { id: uuid(obj.id, `${path}.id`), source: uuid(obj.source, `${path}.source`), target: uuid(obj.target, `${path}.target`) }
}
function scene(value: unknown, path: string): CanvasScene {
  const obj = strict(value, ['nodes', 'edges'], path)
  const nodes = array(obj.nodes, CANVAS_MAX_NODES, `${path}.nodes`, CanvasErrorCode.CANVAS_NODE_LIMIT_EXCEEDED).map((value, i) => node(value, `${path}.nodes[${i}]`))
  const edges = array(obj.edges, CANVAS_MAX_EDGES, `${path}.edges`, CanvasErrorCode.CANVAS_EDGE_LIMIT_EXCEEDED).map((value, i) => edge(value, `${path}.edges[${i}]`))
  const nodeIds = new Set(nodes.map(item => item.id))
  if (nodeIds.size !== nodes.length) invalid(`${path}.nodes`, 'Duplicate node ID', CanvasErrorCode.CANVAS_DUPLICATE_NODE_ID)
  if (new Set(edges.map(item => item.id)).size !== edges.length) invalid(`${path}.edges`, 'Duplicate edge ID', CanvasErrorCode.CANVAS_DUPLICATE_EDGE_ID)
  for (const item of edges) if (!nodeIds.has(item.source) || !nodeIds.has(item.target)) invalid(`${path}.edges`, 'Dangling edge', CanvasErrorCode.CANVAS_DANGLING_REFERENCE)
  for (const item of nodes) if ('sourceNodeId' in item.data && item.data.sourceNodeId !== undefined && !nodeIds.has(item.data.sourceNodeId)) invalid(`${path}.nodes`, 'Dangling sourceNodeId', CanvasErrorCode.CANVAS_DANGLING_REFERENCE)
  const parsed = { nodes, edges }
  // Measure the submitted JSON too: normalization must not bypass the byte limit.
  if (bytes(value) > CANVAS_MAX_SCENE_BYTES || bytes(parsed) > CANVAS_MAX_SCENE_BYTES) invalid(path, 'Scene exceeds UTF-8 byte limit', CanvasErrorCode.CANVAS_SCENE_TOO_LARGE)
  return parsed
}
export function parseCanvasScene(value: unknown): CanvasParseResult<CanvasScene> { return result(() => scene(value, '$')) }
export function parseCanvasNode(value: unknown): CanvasParseResult<CanvasNode> { return result(() => node(value, '$')) }
export function parseCanvasParameters(value: unknown): CanvasParseResult<JsonObject> { return result(() => parameters(value, '$')) }
function canvasFields(obj: Record<string, unknown>): CreateCanvasRequest {
  const output: CreateCanvasRequest = {}
  if ('title' in obj) output.title = title(obj.title, '$.title')
  if ('scene' in obj) output.scene = scene(obj.scene, '$.scene')
  if ('coverAssetId' in obj) output.coverAssetId = obj.coverAssetId === null ? null : uuid(obj.coverAssetId, '$.coverAssetId')
  return output
}
export function parseCreateCanvasRequest(value: unknown): CanvasParseResult<ParsedCreateCanvasRequest> {
  return result(() => ({ title: CANVAS_DEFAULT_TITLE, scene: { nodes: [], edges: [] }, coverAssetId: null,
    ...canvasFields(strict(value, ['title', 'scene', 'coverAssetId'], '$')) }))
}
export function parseUpdateCanvasRequest(value: unknown): CanvasParseResult<UpdateCanvasRequest> {
  return result(() => {
    const obj = strict(value, ['title', 'scene', 'coverAssetId', 'baseRevision'], '$')
    const fields = canvasFields(obj)
    if (!Object.keys(fields).length) invalid('$', 'Empty canvas patch')
    return { ...fields, baseRevision: revision(obj.baseRevision, '$.baseRevision') }
  })
}

function op(value: unknown, path: string): CanvasOp {
  const head = object(value, path)
  switch (head.type) {
    case 'add_node': {
      const obj = strict(value, ['type', 'node'], path)
      return { type: 'add_node', node: node(obj.node, `${path}.node`) }
    }
    case 'update_node': {
      const obj = strict(value, ['type', 'nodeId', 'patch'], path)
      const fields = strict(obj.patch, ['position', 'size', 'data'], `${path}.patch`)
      const patch: CanvasNodePatch = {}
      if ('position' in fields) patch.position = position(fields.position, `${path}.patch.position`)
      if ('size' in fields) patch.size = size(fields.size, `${path}.patch.size`)
      if ('data' in fields) {
        patch.data = dataFields(fields.data, DATA_KEYS, `${path}.patch.data`)
        if (!Object.keys(patch.data).length) invalid(`${path}.patch.data`, 'Empty data patch')
      }
      if (!Object.keys(patch).length) invalid(`${path}.patch`, 'Empty node patch')
      return { type: 'update_node', nodeId: uuid(obj.nodeId, `${path}.nodeId`), patch }
    }
    case 'remove_node': {
      const obj = strict(value, ['type', 'nodeId'], path)
      return { type: 'remove_node', nodeId: uuid(obj.nodeId, `${path}.nodeId`) }
    }
    case 'connect': {
      const obj = strict(value, ['type', 'edge'], path)
      return { type: 'connect', edge: edge(obj.edge, `${path}.edge`) }
    }
    case 'disconnect': {
      const obj = strict(value, ['type', 'edgeId'], path)
      return { type: 'disconnect', edgeId: uuid(obj.edgeId, `${path}.edgeId`) }
    }
    case 'arrange': {
      const obj = strict(value, ['type', 'positions'], path)
      const positions = array(obj.positions, CANVAS_MAX_NODES, `${path}.positions`).map((value, i) => {
        const at = `${path}.positions[${i}]`
        const item = strict(value, ['nodeId', 'position'], at)
        return { nodeId: uuid(item.nodeId, `${at}.nodeId`), position: position(item.position, `${at}.position`) }
      })
      if (!positions.length || new Set(positions.map(item => item.nodeId)).size !== positions.length) invalid(`${path}.positions`, 'Expected nonempty unique positions')
      return { type: 'arrange', positions }
    }
    default: return invalid(`${path}.type`, 'Unknown operation')
  }
}
function ops(value: unknown, path: string): CanvasOp[] {
  return array(value, CANVAS_MAX_OPS, path).map((value, i) => op(value, `${path}[${i}]`))
}
export function parseCanvasOp(value: unknown): CanvasParseResult<CanvasOp> { return result(() => op(value, '$')) }
export function parseCanvasOps(value: unknown): CanvasParseResult<CanvasOp[]> { return result(() => ops(value, '$')) }
/** Applies in order to a detached copy. Invalid batches return only an error;
 * neither input is mutated. Each intermediate scene must be valid (references
 * must already exist); deletion removes incident edges and sourceNodeId refs.
 * Missing targets fail rather than silently discard concurrent edits. */
export function applyCanvasOps(inputScene: unknown, inputOps: unknown): CanvasParseResult<CanvasScene> {
  return result(() => {
    let current = scene(inputScene, '$.scene')
    const parsedOps = ops(inputOps, '$.ops')
    for (const [i, operation] of parsedOps.entries()) {
      const at = `$.ops[${i}]`
      const findNode = (id: string): number => {
        const index = current.nodes.findIndex(item => item.id === id)
        if (index < 0) invalid(at, 'Node not found', CanvasErrorCode.CANVAS_NODE_NOT_FOUND)
        return index
      }
      switch (operation.type) {
        case 'add_node': current.nodes.push(operation.node); break
        case 'update_node': {
          const index = findNode(operation.nodeId)
          const previous = current.nodes[index]!
          current.nodes[index] = node({ ...previous, ...operation.patch,
            data: { ...previous.data, ...operation.patch.data } }, at)
          break
        }
        case 'remove_node': {
          current.nodes.splice(findNode(operation.nodeId), 1)
          current.edges = current.edges.filter(item => item.source !== operation.nodeId && item.target !== operation.nodeId)
          for (const item of current.nodes) if ('sourceNodeId' in item.data && item.data.sourceNodeId === operation.nodeId) delete item.data.sourceNodeId
          break
        }
        case 'connect': current.edges.push(operation.edge); break
        case 'disconnect': {
          const index = current.edges.findIndex(item => item.id === operation.edgeId)
          if (index < 0) invalid(at, 'Edge not found', CanvasErrorCode.CANVAS_EDGE_NOT_FOUND)
          current.edges.splice(index, 1)
          break
        }
        case 'arrange': for (const item of operation.positions) current.nodes[findNode(item.nodeId)]!.position = item.position; break
      }
      current = scene(current, '$.scene')
    }
    return current
  })
}
function editSelection(value: unknown, path: string): CanvasAgentEditSelection {
  const obj = strict(value, ['x', 'y', 'width', 'height'], path)
  for (const k of ['x', 'y'] as const) {
    if (typeof obj[k] !== 'number' || !Number.isFinite(obj[k]) || (obj[k] as number) < 0) {
      invalid(`${path}.${k}`, 'Expected finite non-negative number')
    }
  }
  for (const k of ['width', 'height'] as const) {
    if (typeof obj[k] !== 'number' || !Number.isFinite(obj[k]) || (obj[k] as number) <= 0) {
      invalid(`${path}.${k}`, 'Expected finite positive number')
    }
  }
  return { x: obj.x as number, y: obj.y as number, width: obj.width as number, height: obj.height as number }
}
export function parseCanvasAgentEditMetadata(value: unknown): CanvasParseResult<CanvasAgentEditMetadata> {
  return result(() => {
    const obj = strict(value, ['selection', 'sourceWidth', 'sourceHeight'], '$')
    const selection = editSelection(obj.selection, '$.selection')
    const sourceWidth = integer(obj.sourceWidth, 1, 32768, '$.sourceWidth')
    const sourceHeight = integer(obj.sourceHeight, 1, 32768, '$.sourceHeight')
    if (selection.x + selection.width > sourceWidth || selection.y + selection.height > sourceHeight) invalid('$.selection', 'Selection exceeds source dimensions')
    return { selection, sourceWidth, sourceHeight }
  })
}
function structuredInputItem(value: unknown, path: string): CanvasAgentStructuredInputItem {
  const obj = strict(value, ['uploadId', 'assetId', 'role', 'position'], path)
  const hasUpload = 'uploadId' in obj && obj.uploadId !== undefined
  const hasAsset = 'assetId' in obj && obj.assetId !== undefined
  if (hasUpload === hasAsset) invalid(path, 'Expected exactly one of uploadId or assetId')
  const uploadId = hasUpload ? uuid(obj.uploadId, `${path}.uploadId`) : undefined
  const assetId = hasAsset ? uuid(obj.assetId, `${path}.assetId`) : undefined
  const roleStr = text(obj.role, `${path}.role`, true)
  if (roleStr.length > 64) invalid(`${path}.role`, 'Role exceeds 64 characters')
  const pos = integer(obj.position, 0, 15, `${path}.position`)
  return { ...(uploadId ? { uploadId } : {}), ...(assetId ? { assetId } : {}), role: roleStr, position: pos }
}
function structuredEditSource(value: unknown, path: string): CanvasAgentStructuredEditSource {
  const obj = strict(value, ['assetId', 'nodeId', 'selection'], path)
  const hasAsset = 'assetId' in obj && obj.assetId !== undefined
  const hasNode = 'nodeId' in obj && obj.nodeId !== undefined
  if (!hasAsset && !hasNode) invalid(path, 'Expected at least one of assetId or nodeId')
  const assetId = hasAsset ? uuid(obj.assetId, `${path}.assetId`) : undefined
  const nodeId = hasNode ? uuid(obj.nodeId, `${path}.nodeId`) : undefined
  const sel = editSelection(obj.selection, `${path}.selection`)
  return { ...(assetId ? { assetId } : {}), ...(nodeId ? { nodeId } : {}), selection: sel }
}
function structuredContext(value: unknown, path: string): CanvasAgentStructuredContext {
  const obj = strict(value, ['intent', 'modelId', 'parameters', 'inputs', 'editSource'], path)
  const output: CanvasAgentStructuredContext = {}
  const res = output as Record<string, unknown>
  if ('intent' in obj && obj.intent !== undefined) {
    if (!['generate', 'edit', 'continue'].includes(String(obj.intent))) invalid(`${path}.intent`, 'Invalid intent')
    res.intent = obj.intent
  }
  if ('modelId' in obj && obj.modelId !== undefined) res.modelId = uuid(obj.modelId, `${path}.modelId`)
  if ('parameters' in obj && obj.parameters !== undefined) res.parameters = parameters(obj.parameters, `${path}.parameters`)
  if ('inputs' in obj && obj.inputs !== undefined) {
    res.inputs = array(obj.inputs, 16, `${path}.inputs`).map((it, i) => structuredInputItem(it, `${path}.inputs[${i}]`))
  }
  if ('editSource' in obj && obj.editSource !== undefined) {
    res.editSource = structuredEditSource(obj.editSource, `${path}.editSource`)
  }
  return output
}
function sceneCommitMode(value: unknown, path: string): CanvasAgentSceneCommitMode {
  if (value !== 'client-managed' && value !== 'agent-managed') invalid(path, 'Expected client-managed or agent-managed')
  return value
}
export function parseCanvasAgentMessageRequest(value: unknown): CanvasParseResult<CanvasAgentMessageRequest> {
  return result(() => {
    const head = object(value, '$')
    if (head.kind === 'user') {
      const obj = strict(value, ['kind', 'messageId', 'text', 'baseRevision', 'requireConfirmation', 'sceneCommitMode', 'context'], '$')
      const req: CanvasAgentMessageRequest = {
        kind: 'user',
        messageId: uuid(obj.messageId, '$.messageId'),
        text: text(obj.text, '$.text', true),
        baseRevision: revision(obj.baseRevision, '$.baseRevision'),
        requireConfirmation: 'requireConfirmation' in obj
          ? boolean(obj.requireConfirmation, '$.requireConfirmation')
          : CANVAS_AGENT_DEFAULT_REQUIRE_CONFIRMATION,
        sceneCommitMode: 'sceneCommitMode' in obj
          ? sceneCommitMode(obj.sceneCommitMode, '$.sceneCommitMode')
          : 'client-managed',
        ...('context' in obj && obj.context !== undefined
          ? { context: structuredContext(obj.context, '$.context') }
          : {}),
      }
      return req
    }
    if (head.kind === 'job_event') {
      const obj = strict(value, ['kind', 'messageId', 'jobId', 'baseRevision', 'sceneCommitMode'], '$')
      return {
        kind: 'job_event',
        messageId: uuid(obj.messageId, '$.messageId'),
        jobId: uuid(obj.jobId, '$.jobId'),
        baseRevision: revision(obj.baseRevision, '$.baseRevision'),
        sceneCommitMode: 'sceneCommitMode' in obj
          ? sceneCommitMode(obj.sceneCommitMode, '$.sceneCommitMode')
          : 'client-managed',
      }
    }
    return invalid('$.kind', 'Unknown message kind')
  })
}
export function parseCanvasAgentConfirmRequest(value: unknown): CanvasParseResult<CanvasAgentConfirmRequest> {
  return result(() => {
    const obj = strict(value, ['pendingId', 'approve'], '$')
    return { pendingId: uuid(obj.pendingId, '$.pendingId'), approve: boolean(obj.approve, '$.approve') }
  })
}
export function parseCanvasAgentApplyRequest(value: unknown): CanvasParseResult<CanvasAgentApplyRequest> {
  return result(() => {
    const obj = strict(value, ['turnId'], '$')
    return { turnId: uuid(obj.turnId, '$.turnId') }
  })
}
export function parseUpdateCanvasAgentSettingsRequest(value: unknown): CanvasParseResult<UpdateCanvasAgentSettingsRequest> {
  return result(() => {
    const obj = strict(value, ['enabled', 'languageModelConfigId', 'maxToolCallsPerTurn', 'maxJobsPerTurn', 'timeoutMs', 'maxAutoContinuations'], '$')
    if (!Object.keys(obj).length) invalid('$', 'Empty settings patch')
    const output: UpdateCanvasAgentSettingsRequest = {}
    if ('enabled' in obj) output.enabled = boolean(obj.enabled, '$.enabled')
    if ('languageModelConfigId' in obj) output.languageModelConfigId = obj.languageModelConfigId === null ? null : uuid(obj.languageModelConfigId, '$.languageModelConfigId')
    for (const [key, min, max] of [
      ['maxToolCallsPerTurn', 1, 32], ['maxJobsPerTurn', 1, 8], ['timeoutMs', 1000, 300_000], ['maxAutoContinuations', 0, 10],
    ] as const) if (key in obj) output[key] = integer(obj[key], min, max, `$.${key}`)
    return output
  })
}
