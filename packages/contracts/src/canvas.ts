/**
 * @deprecated 画布（Canvas）功能已废弃（2026-11-18，见 docs/canvas-deprecation.md）。
 * 后端已删除全部画布逻辑；本文件仅为 web 前端过渡期保留的类型 shim，
 * 前端画布触点移除后整文件删除。
 */
import type { JsonObject, JsonValue } from './index'
import { isUuid } from './uuid'

export const CANVAS_MAX_SCENE_BYTES = 512 * 1024
export const CANVAS_MAX_NODES = 500
export const CANVAS_MAX_EDGES = 1000
export const CANVAS_MAX_TITLE_LENGTH = 120
export const CANVAS_DEFAULT_TITLE = '未命名画布'
export const CANVAS_MAX_TEXT_LENGTH = 16_000
export const CANVAS_MAX_PARAMETERS_BYTES = 32 * 1024
export const CANVAS_MAX_PARAMETERS_DEPTH = 8
export const CANVAS_MAX_JSON_VALUES = 4096
export const CanvasErrorCode = {
  INVALID_INPUT: 'INVALID_INPUT',
  CANVAS_NOT_FOUND: 'CANVAS_NOT_FOUND',
  CANVAS_REVISION_CONFLICT: 'CANVAS_REVISION_CONFLICT',
  CANVAS_SCENE_TOO_LARGE: 'CANVAS_SCENE_TOO_LARGE',
  CANVAS_NODE_LIMIT_EXCEEDED: 'CANVAS_NODE_LIMIT_EXCEEDED',
  CANVAS_EDGE_LIMIT_EXCEEDED: 'CANVAS_EDGE_LIMIT_EXCEEDED',
  CANVAS_DUPLICATE_NODE_ID: 'CANVAS_DUPLICATE_NODE_ID',
  CANVAS_DUPLICATE_EDGE_ID: 'CANVAS_DUPLICATE_EDGE_ID',
  CANVAS_DANGLING_REFERENCE: 'CANVAS_DANGLING_REFERENCE',
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

/** Validated data fields shared by the ordinary Canvas node parsers. */
export type CanvasNodeDataPatch = Partial<CanvasPromptData & CanvasMediaData & CanvasNoteData>

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
/** Canvas ids are plain UUIDs; the predicate keeps its canvas name for readability at callsites. */
export const isCanvasUuid = isUuid
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
