import { isUuid, type GenerationMode, type JsonObject, type ToolExecutionResult } from '@musecanvas/contracts'
import { adaptAgentToolContext, completedOutputBytes, MAX_TOOL_OUTPUT_BYTES, toolSchemaToJson, ToolRegistry, ToolValidationError, type InstalledTool, type ToolContext, type ToolSchema } from './registry'
import type { AgentTool, AgentToolContext } from '../ports'

export const READONLY_TOOL_ALLOWLIST = ['list_models@v1', 'search_assets@v1', 'get_asset@v1'] as const
const MODES: GenerationMode[] = ['text_to_image', 'image_to_image', 'inpaint', 'text_to_video', 'image_to_video']
const string = (maxLength: number): ToolSchema => ({ type: 'string', maxLength })
const uuid: ToolSchema = { type: 'string', format: 'uuid', maxLength: 36 }
const integer = (maximum: number): ToolSchema => ({ type: 'integer', minimum: 1, maximum })
const object = (properties: Record<string, ToolSchema>, required: string[] = []): ToolSchema => ({ type: 'object', properties, required, additionalProperties: false })
const mediaKind: ToolSchema = { type: 'string', maxLength: 5, enum: ['image', 'video'] }
const schemas = {
  list_models: object({ mode: { type: 'string', maxLength: 20, enum: MODES }, limit: integer(100) }),
  search_assets: object({ query: string(100), mediaKind, limit: integer(50), cursor: string(256) }),
  get_asset: object({ assetId: uuid }, ['assetId']),
}

interface AssetRow extends Record<string, unknown> {
  id: string
  media_kind: 'image' | 'video'
  mime_type: string
  width: number | null
  height: number | null
  duration_seconds: string | number | null
  fps: string | number | null
  has_audio: boolean | null
  size_bytes: number | string
  cursor_created_at: string
}
interface ModelRow extends Record<string, unknown> {
  id: string
  display_name: string
  model_kind: 'image' | 'video'
  revision_id: string
  revision: number
  modes: unknown
  max_count: unknown
}
interface AssetCursor { createdAt: string; id: string }

function invalidRow(): never { throw new Error('Invalid tool query row') }
function media(value: unknown): value is 'image' | 'video' { return value === 'image' || value === 'video' }
function nullableNumber(value: unknown): value is number | null { return value === null || typeof value === 'number' }
function pgNumeric(value: unknown): value is string | number { return typeof value === 'string' || typeof value === 'number' }
function assetRow(row: Record<string, unknown>): AssetRow {
  if (!isUuid(row.id) || !media(row.media_kind) || typeof row.mime_type !== 'string'
    || !nullableNumber(row.width) || !nullableNumber(row.height)
    || (row.duration_seconds !== null && !pgNumeric(row.duration_seconds)) || (row.fps !== null && !pgNumeric(row.fps))
    || (row.has_audio !== null && typeof row.has_audio !== 'boolean') || !pgNumeric(row.size_bytes)
    || !validTimestamp(row.cursor_created_at)) invalidRow()
  return { id: row.id, media_kind: row.media_kind, mime_type: row.mime_type, width: row.width, height: row.height,
    duration_seconds: row.duration_seconds, fps: row.fps, has_audio: row.has_audio, size_bytes: row.size_bytes, cursor_created_at: row.cursor_created_at }
}
function modelRow(row: Record<string, unknown>): ModelRow {
  if (!isUuid(row.id) || typeof row.display_name !== 'string' || !media(row.model_kind)
    || !isUuid(row.revision_id) || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) invalidRow()
  return { id: row.id, display_name: row.display_name, model_kind: row.model_kind, revision_id: row.revision_id,
    revision: row.revision, modes: row.modes, max_count: row.max_count }
}

function invalid(): never { throw new ToolValidationError('INVALID_ARGUMENTS') }
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(value) || value.startsWith('0000')) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === `${value.slice(0, 23)}Z`
}
function decodeCursor(value: string): AssetCursor {
  if (!value || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid()
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) invalid()
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { invalid() }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid()
  const cursor = parsed as Record<string, unknown>
  if (Object.keys(cursor).sort().join(',') !== 'createdAt,id' || !validTimestamp(cursor.createdAt) || !isUuid(cursor.id)) invalid()
  return { createdAt: cursor.createdAt, id: cursor.id.toLowerCase() }
}
function encodeCursor(row: AssetRow): string {
  if (!validTimestamp(row.cursor_created_at) || !isUuid(row.id)) throw new Error('Invalid asset cursor row')
  return Buffer.from(JSON.stringify({ createdAt: row.cursor_created_at, id: row.id })).toString('base64url')
}
function numeric(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : null
}
function identifier(value: unknown): string | null { return isUuid(value) ? value : null }
function label(value: string): string {
  // Catalog labels are untrusted display data, never routing/configuration.
  return Array.from(value.replace(/(?:https?:\/\/|s3:\/\/|data:)[^\s]*/gi, '[redacted]').replaceAll('\u0000', '')).slice(0, 120).join('')
}
function assetDto(row: AssetRow): JsonObject {
  if (!isUuid(row.id) || !['image', 'video'].includes(row.media_kind) || !validTimestamp(row.cursor_created_at)) throw new Error('Invalid asset metadata')
  const mimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime']
  return { id: row.id, mediaKind: row.media_kind, mimeType: mimeTypes.includes(row.mime_type) ? row.mime_type : 'application/octet-stream',
    width: numeric(row.width), height: numeric(row.height), durationSeconds: numeric(row.duration_seconds), fps: numeric(row.fps),
    hasAudio: typeof row.has_audio === 'boolean' ? row.has_audio : null, sizeBytes: numeric(row.size_bytes), createdAt: row.cursor_created_at }
}
function completed(result: JsonObject): ToolExecutionResult {
  if (completedOutputBytes(result) > MAX_TOOL_OUTPUT_BYTES) throw new ToolValidationError('RESULT_TOO_LARGE')
  return { kind: 'completed', result }
}
function notFound(): ToolExecutionResult {
  // Missing, deleted, unready and foreign resources are deliberately indistinguishable.
  return { kind: 'failed', error: { code: 'TOOL_FAILED', message: 'Resource unavailable', retryable: false } }
}
const assetColumns = `a.id,a.media_kind,a.mime_type,a.width,a.height,a.duration_seconds,a.fps,a.has_audio,a.size_bytes,
  to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at`
const readyAssets = `FROM assets a JOIN generation_jobs j ON j.id=a.job_id
  WHERE a.created_by=$1 AND j.created_by=$1 AND a.deleted_at IS NULL AND j.deleted_at IS NULL
    AND j.status='succeeded' AND a.media_kind IN ('image','video')`

async function listModels(context: ToolContext, args: JsonObject): Promise<ToolExecutionResult> {
  const limit = (args.limit as number | undefined) ?? 50
  // Models are a shared catalog, not owner-created resources. Only active,
  // credential-backed revisions with declared capabilities are selectable.
  const rows = (await context.query.query<ModelRow>(`SELECT m.id,m.display_name,m.model_kind,rev.id AS revision_id,rev.revision,
      rev.capabilities->'modes' AS modes,rev.capabilities->'maxCount' AS max_count
    FROM model_configs m JOIN model_config_revisions rev ON rev.id=m.latest_revision_id AND rev.model_id=m.id
    JOIN provider_credentials pc ON pc.id=rev.credential_id AND pc.enabled=true AND pc.deleted_at IS NULL
    WHERE m.enabled=true AND m.deleted_at IS NULL AND m.model_kind IN ('image','video')
      AND COALESCE(NULLIF(pc.payload_encrypted,''),NULLIF(pc.api_key_encrypted,'')) IS NOT NULL
      AND rev.capabilities->>'declaredBy' IN ('plugin-manifest','host-synthesized')
      AND jsonb_typeof(rev.capabilities->'modes')='array'
      AND ($1::text IS NULL OR (rev.capabilities->'modes') ? $1::text)
    ORDER BY m.sort_order,m.id LIMIT $2`, [args.mode ?? null, limit + 1], modelRow)).rows
  const candidates = rows.slice(0, limit)
  const items: JsonObject[] = []
  let truncated = rows.length > limit
  for (const row of candidates) {
    const declaredModes = row.modes
    const modes = Array.isArray(declaredModes) ? MODES.filter(mode => declaredModes.includes(mode)
      && (row.model_kind === 'image' ? ['text_to_image', 'image_to_image', 'inpaint'].includes(mode) : ['text_to_video', 'image_to_video'].includes(mode))) : []
    if (!identifier(row.id) || !identifier(row.revision_id) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !modes.length || (args.mode && !modes.includes(args.mode as GenerationMode))) continue
    items.push({ id: row.id, displayName: label(row.display_name), modelKind: row.model_kind, revisionId: row.revision_id, revision: row.revision,
      modes, maxCount: numeric(row.max_count), estimatedCost: null })
    if (completedOutputBytes({ items, truncated }) > MAX_TOOL_OUTPUT_BYTES) { items.pop(); truncated = true; break }
  }
  return completed({ items, truncated })
}

async function searchAssets(context: ToolContext, args: JsonObject): Promise<ToolExecutionResult> {
  const limit = (args.limit as number | undefined) ?? 20
  const cursor = args.cursor === undefined ? null : decodeCursor(args.cursor as string)
  // Search only the user's original prompt. Hidden optimized prompts are not a search oracle.
  const query = (args.query as string | undefined)?.trim()
  const pattern = query ? `%${query.replace(/[\\%_]/g, '\\$&')}%` : null
  const rows = (await context.query.query<AssetRow>(`SELECT ${assetColumns} ${readyAssets}
      AND ($3::text IS NULL OR a.prompt ILIKE $3 ESCAPE E'\\\\')
      AND ($4::text IS NULL OR a.media_kind=$4)
      AND ($5::timestamptz IS NULL OR (a.created_at,a.id)<($5::timestamptz,$6::uuid))
    ORDER BY a.created_at DESC,a.id DESC LIMIT $2`, [context.ownerId, limit + 1, pattern, args.mediaKind ?? null, cursor?.createdAt ?? null, cursor?.id ?? null], assetRow)).rows
  const visible = rows.slice(0, limit)
  let result: JsonObject
  for (;;) {
    const hasMore = rows.length > visible.length
    const last = visible.at(-1)
    result = { items: visible.map(assetDto), hasMore, nextCursor: hasMore && last ? encodeCursor(last) : null }
    if (completedOutputBytes(result) <= MAX_TOOL_OUTPUT_BYTES) break
    if (visible.length <= 1) throw new ToolValidationError('RESULT_TOO_LARGE')
    visible.pop()
  }
  return completed(result)
}
async function getAsset(context: ToolContext, args: JsonObject): Promise<ToolExecutionResult> {
  const row = (await context.query.query<AssetRow>(`SELECT ${assetColumns} ${readyAssets} AND a.id=$2::uuid LIMIT 1`, [context.ownerId, args.assetId], assetRow)).rows[0]
  return row ? completed({ asset: assetDto(row) }) : notFound()
}

export function readonlyTools<Context extends ToolContext = ToolContext>(): InstalledTool<Context>[] {
  const handlers = { list_models: listModels, search_assets: searchAssets, get_asset: getAsset }
  return Object.entries(handlers).map(([name, execute]) => ({ name, schemaVersion: 1, parameters: structuredClone(schemas[name as keyof typeof schemas]),
    description: { list_models: 'List active media model revisions and declared modes. Cost is unknown when null.',
      search_assets: 'Search your ready assets by original prompt with bounded keyset pagination. Returns metadata and IDs only.',
      get_asset: 'Read metadata for one of your ready assets. No URLs or storage locators are returned.' }[name]!,
    permissions: [name === 'list_models' ? 'models:read' : 'assets:read'], execution: 'sync', execute }))
}
export function createReadonlyToolRegistry<Context extends ToolContext = ToolContext>(options: { allowlist?: readonly string[]; mediaTools?: InstalledTool<Context>[] } = {}): ToolRegistry<Context> {
  return new ToolRegistry({ tools: readonlyTools<Context>(), allowlist: options.allowlist ?? READONLY_TOOL_ALLOWLIST, mediaTools: options.mediaTools })
}

/** Shared-port tools delegate to the same allowlisted, versioned implementation. */
export function createReadonlyAgentTools(options: { readonly allowlist?: readonly string[] } = {}): readonly AgentTool[] {
  const tools = readonlyTools()
  const registry = new ToolRegistry({ tools, allowlist: options.allowlist ?? READONLY_TOOL_ALLOWLIST })
  return Object.freeze(registry.listDefinitions().map(definition => Object.freeze({
    name: definition.name, schemaVersion: definition.schemaVersion, description: definition.description,
    parameters: toolSchemaToJson(definition.parameters), permissions: Object.freeze([...definition.permissions]), execution: definition.execution,
    approval: 'never' as const, budget: Object.freeze({ maxMediaJobs: 0, maxMediaOutputs: 0, maxEstimatedCost: null }),
    execute: (context: AgentToolContext, args: JsonObject) => registry.dispatch(adaptAgentToolContext(context),
      { toolName: definition.name, schemaVersion: definition.schemaVersion, arguments: args }),
  })))
}
