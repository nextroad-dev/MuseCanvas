import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as canvas from '@musecanvas/contracts'
import { DELETE_ROUTES, GET_ROUTES, PATCH_ROUTES, POST_ROUTES } from './routes'
import { agentStream } from '../modules/canvases/agent/sse'
import { NextRequest } from 'next/server'
import type pg from 'pg'
import { createCanvasAgentHandlers } from '../modules/canvases/agent/handlers'
import { PgAgentStore } from '../modules/canvases/agent/store'
import { listCanvases } from '../modules/canvases/handlers'
import { mutationOriginValid } from '../shared/http'
import type { AuthedContext, Route } from './types'

interface Schema {
  $ref?: string
  type?: string | string[]
  const?: unknown
  enum?: unknown[]
  oneOf?: Schema[]
  anyOf?: Schema[]
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean | Schema
  items?: Schema
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  minItems?: number
  maxItems?: number
  minProperties?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  default?: unknown
  examples?: unknown[]
  discriminator?: { propertyName: string; mapping: Record<string, string> }
  [extension: string]: unknown
}
interface Media {
  schema: Schema
  examples?: Record<string, { value: unknown }>
  'x-event-schema'?: Schema
  'x-comment-examples'?: string[]
}
interface Operation {
  operationId: string
  'x-access': string
  security: unknown
  parameters?: Array<{ name: string; in: string; required: boolean; schema: Schema }>
  requestBody?: { required: boolean; content: Record<string, Media> }
  responses: Record<string, { content: Record<string, Media>; 'x-error-codes'?: string[] }>
}
interface CanvasOpenApi {
  openapi: string
  info: { description: string }
  security: unknown
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, Schema>; securitySchemes: Record<string, unknown> }
}

// Pretty JSON is valid YAML 1.2: deliberately no YAML parser dependency or regex YAML parser.
const document: CanvasOpenApi = JSON.parse(readFileSync(new URL('../../../../openapi.yml', import.meta.url), 'utf8'))
const schemas = document.components.schemas
const tables: Array<[string, Route[]]> = [
  ['get', GET_ROUTES], ['post', POST_ROUTES], ['patch', PATCH_ROUTES], ['delete', DELETE_ROUTES],
]
const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({ path, method, operation })))
const uuid = '123e4567-e89b-12d3-a456-426614174000'

function resolve(reference: string): unknown {
  assert.ok(reference.startsWith('#/'), `Only local references expected: ${reference}`)
  let value: unknown = document
  for (const part of reference.slice(2).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    assert.ok(value && typeof value === 'object' && Object.hasOwn(value, part), `Missing ref target: ${reference}`)
    value = (value as Record<string, unknown>)[part]
  }
  return value
}
function visit(value: unknown, fn: (object: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const item of value) visit(item, fn); return }
  fn(value as Record<string, unknown>)
  for (const item of Object.values(value)) visit(item, fn)
}

/** Small example checker ONLY for keywords used here, NOT a full JSON Schema/OpenAPI validator.
 * Runtime parsers below remain the authority for graph/bytes/UTF-16/normalization rules.
 * Ignore documentation/x-* keywords; $ref siblings still apply (OpenAPI 3.1).
 */
function matches(value: unknown, schema: Schema): boolean {
  if (schema.$ref && !matches(value, resolve(schema.$ref) as Schema)) return false
  if (schema.oneOf && schema.oneOf.filter(item => matches(value, item)).length !== 1) return false
  if (schema.anyOf && !schema.anyOf.some(item => matches(value, item))) return false
  if (Object.hasOwn(schema, 'const') && !assertEqual(value, schema.const)) return false
  if (schema.enum && !schema.enum.some(item => assertEqual(value, item))) return false
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => type === 'null' ? value === null
      : type === 'array' ? Array.isArray(value)
        : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value)
            : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
              : typeof value === type)) return false
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return false
    if (schema.maximum !== undefined && value > schema.maximum) return false
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false
  }
  if (typeof value === 'string') {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength) return false
    if (schema.maxLength !== undefined && length > schema.maxLength) return false
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false
    if (schema.format === 'uuid' && !canvas.isCanvasUuid(value)) return false
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))) return false
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false
    if (schema.items && !value.every(item => matches(item, schema.items!))) return false
  } else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (schema.minProperties !== undefined && Object.keys(object).length < schema.minProperties) return false
    if (schema.required?.some(key => !Object.hasOwn(object, key))) return false
    for (const [key, item] of Object.entries(object)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        if (!matches(item, schema.properties[key]!)) return false
      } else if (schema.additionalProperties === false) return false
      else if (typeof schema.additionalProperties === 'object' && !matches(item, schema.additionalProperties)) return false
    }
  }
  return true
}
function assertEqual(a: unknown, b: unknown): boolean {
  try { assert.deepEqual(a, b); return true } catch { return false }
}

const parsers: Record<string, (value: unknown) => { success: boolean }> = {
  CreateCanvasRequest: canvas.parseCreateCanvasRequest,
  UpdateCanvasRequest: canvas.parseUpdateCanvasRequest,
  CanvasAgentMessageRequest: canvas.parseCanvasAgentMessageRequest,
  CanvasAgentConfirmRequest: canvas.parseCanvasAgentConfirmRequest,
  CanvasAgentApplyRequest: canvas.parseCanvasAgentApplyRequest,
  UpdateCanvasAgentSettingsRequest: canvas.parseUpdateCanvasAgentSettingsRequest,
  UpdateMediaModelDefaultsRequest: canvas.parseUpdateMediaModelDefaultsRequest,
  CanvasNode: canvas.parseCanvasNode,
  CanvasScene: canvas.parseCanvasScene,
  CanvasOp: canvas.parseCanvasOp,
  CanvasOps: canvas.parseCanvasOps,
  Parameters: canvas.parseCanvasParameters,
}

test('canvas-openapi: native JSON/YAML 1.2, all references resolve and operation IDs are unique', () => {
  assert.equal(document.openapi, '3.1.0')
  assert.match(document.info.description, /JSON is valid YAML 1\.2/)
  let refs = 0
  visit(document, object => {
    if (typeof object.$ref === 'string') { resolve(object.$ref); refs++ }
    const discriminator = object.discriminator as Schema['discriminator']
    if (discriminator) for (const reference of Object.values(discriminator.mapping)) resolve(reference)
  })
  assert.ok(refs > 100)
  assert.equal(new Set(operations.map(item => item.operation.operationId)).size, operations.length)
  assert.ok(operations.every(item => item.operation.operationId.length > 0))
})

test('canvas-openapi: canvas and recovery routes biject with canvas/settings routes, endpoints and access', () => {
  const registered = tables.flatMap(([method, routes]) => routes
    .filter(route => route.path === 'canvases' || route.path.startsWith('canvases/') || route.path === 'admin/canvas-agent-settings' || route.path === 'admin/media-model-defaults')
    .map(route => ({ method, path: `/api/${route.path.replace(/:([A-Za-z]+)/g, '{$1}')}`, access: route.access })))
  assert.equal(Object.keys(document.paths).length, 9)
  assert.equal(operations.length, 14)
  const key = (item: { method: string; path: string }) => `${item.method} ${item.path}`
  assert.deepEqual(operations.map(key).sort(), registered.map(key).sort())
  const endpoints = canvas.API_ENDPOINTS
  const declared = [endpoints.canvases.list, endpoints.canvases.create,
    endpoints.canvases.detail('{id}'), endpoints.canvases.update('{id}'), endpoints.canvases.remove('{id}'),
    endpoints.canvases.agent.messages('{id}'), endpoints.canvases.agent.history('{id}'),
    endpoints.canvases.agent.turn('{id}', '{turnId}'), endpoints.canvases.agent.confirm('{id}'), endpoints.canvases.agent.apply('{id}'), endpoints.admin.canvasAgentSettings, endpoints.admin.mediaModelDefaults]
  assert.deepEqual(Object.keys(document.paths).sort(), [...new Set(declared)].sort())
  assert.deepEqual(document.security, [{ museSession: [] }])
  const scheme = document.components.securitySchemes.museSession as Record<string, unknown>
  assert.deepEqual([scheme.type, scheme.in, scheme.name], ['apiKey', 'cookie', 'muse_session'])
  assert.deepEqual(Object.keys(document.components.securitySchemes), ['museSession'])
  for (const { path, method, operation } of operations) {
    assert.equal(operation['x-access'], registered.find(item => item.path === path && item.method === method)!.access)
    assert.equal(operation['x-access'], path.startsWith('/api/admin/') ? 'admin' : 'actor')
    assert.deepEqual(operation.security, [{ museSession: [] }])
    const names = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1])
    const params = (operation.parameters ?? []).filter(item => item.in === 'path')
    assert.deepEqual(params.map(item => item.name).sort(), names.sort())
    for (const param of params) { assert.equal(param.required, true); assert.deepEqual(param.schema, { $ref: '#/components/schemas/Uuid' }) }
  }
})

test('canvas-openapi: exact HTTP status sets, envelopes and error codes for the subset', () => {
  const expected: Record<string, number[]> = {
    listCanvases: [200, 400, 401], createCanvas: [201, 400, 401, 403, 429],
    getCanvas: [200, 400, 401, 404], updateCanvas: [200, 400, 401, 403, 404, 409, 429],
    deleteCanvas: [200, 400, 401, 403, 404, 429],
    postCanvasAgentMessages: [200, 400, 401, 403, 404, 409, 429, 503],
    getCanvasAgentHistory: [200, 400, 401, 403, 404, 429, 503],
    getCanvasAgentTurn: [200, 400, 401, 403, 404, 429, 503],
    postCanvasAgentConfirm: [200, 400, 401, 403, 404, 409, 429, 503],
    postCanvasAgentApply: [200, 400, 401, 403, 404, 409, 429, 503],
    readCanvasAgentSettings: [200, 401, 403, 503], updateCanvasAgentSettings: [200, 400, 401, 403, 409, 503],
    readMediaModelDefaults: [200, 401, 403], updateMediaModelDefaults: [200, 400, 401, 403, 503],
  }
  assert.deepEqual(schemas.CanvasErrorCode!.enum, Object.values(canvas.CanvasErrorCode))
  for (const { operation, method } of operations) {
    assert.deepEqual(Object.keys(operation.responses).map(Number).sort((a, b) => a - b), expected[operation.operationId])
    assert.deepEqual(operation.responses['401']!['x-error-codes'], ['UNAUTHORIZED'])
    if (method !== 'get') assert.ok(operation.responses['403']!['x-error-codes']!.includes('CSRF_REJECTED'))
    if (operation['x-access'] === 'admin') assert.ok(operation.responses['403']!['x-error-codes']!.includes('FORBIDDEN'))
    for (const [status, response] of Object.entries(operation.responses)) {
      if (Number(status) >= 400) {
        assert.deepEqual(response.content['application/json']!.schema, { $ref: '#/components/schemas/ErrorEnvelope' })
        assert.ok(response['x-error-codes']!.length)
      } else if (operation.operationId !== 'postCanvasAgentMessages') {
        const envelope = resolve(response.content['application/json']!.schema.$ref!) as Schema
        assert.equal(envelope.properties!.success!.const, true)
        assert.deepEqual(envelope.required, ['success', 'data'])
      }
    }
  }
  assert.deepEqual(schemas.DeleteCanvasEnvelope!.properties!.data!.properties, { id: { $ref: '#/components/schemas/Uuid' } })
  assert.deepEqual(schemas.ErrorEnvelope!.properties!.error!.required, ['code', 'message'])
  assert.equal(schemas.ErrorEnvelope!.properties!.success!.const, false)
})

test('canvas-openapi: typed node/op/event discriminator unions and every JSON example', () => {
  for (const [name, variants, property] of [
    ['CanvasNode', ['prompt', 'image', 'video', 'note'], 'type'],
    ['CanvasOp', ['add_node', 'update_node', 'remove_node', 'connect', 'disconnect', 'arrange'], 'type'],
    ['CanvasAgentMessageRequest', ['user', 'job_event'], 'kind'],
    ['AgentStreamEvent', ['text_delta', 'tool_call', 'tool_result', 'canvas_ops', 'pending_jobs', 'confirm_required', 'done', 'error'], 'type'],
  ] as const) {
    const union = schemas[name]!
    assert.equal(union.discriminator!.propertyName, property)
    assert.deepEqual(Object.keys(union.discriminator!.mapping), variants)
    assert.equal(union.oneOf!.length, variants.length)
    for (const variant of variants) {
      const target = union.discriminator!.mapping[variant]!
      assert.ok(union.oneOf!.some(item => item.$ref === target))
      const schema = resolve(target) as Schema
      assert.equal(schema.additionalProperties, false)
      assert.equal(schema.properties![property]!.const, variant)
      assert.ok(schema.required!.includes(property))
    }
  }
  // Reject permissive typed-object placeholders; only dynamic JSON has schema-valued additionalProperties.
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.type === 'object' && name !== 'JsonObject') {
      assert.equal(schema.additionalProperties, false, name)
      assert.ok(Object.keys(schema.properties!).length > 0, name)
    }
    for (const example of schema.examples ?? []) assert.ok(matches(example, schema), `${name} schema example`)
  }
  for (const { operation } of operations) {
    for (const content of [operation.requestBody?.content, ...Object.values(operation.responses).map(item => item.content)]) {
      for (const [type, media] of Object.entries(content ?? {})) {
        if (type === 'text/event-stream') continue
        for (const example of Object.values(media.examples ?? {})) assert.ok(matches(example.value, media.schema), `${operation.operationId} ${type} example`)
      }
    }
  }
})

test('canvas-openapi: documented limits/defaults match contracts and runtime parser boundaries', () => {
  assert.equal(schemas.CanvasScene!['x-max-utf8-bytes'], canvas.CANVAS_MAX_SCENE_BYTES)
  assert.equal(schemas.CanvasScene!.properties!.nodes!.maxItems, canvas.CANVAS_MAX_NODES)
  assert.equal(schemas.CanvasScene!.properties!.edges!.maxItems, canvas.CANVAS_MAX_EDGES)
  assert.equal(schemas.TitleInput!['x-max-trimmed-length'], canvas.CANVAS_MAX_TITLE_LENGTH)
  assert.equal(schemas.TitleInput!.default, canvas.CANVAS_DEFAULT_TITLE)
  assert.equal(schemas.Text!.maxLength, canvas.CANVAS_MAX_TEXT_LENGTH)
  assert.equal(schemas.Text!['x-max-utf16-code-units'], canvas.CANVAS_MAX_TEXT_LENGTH)
  assert.equal(schemas.Parameters!['x-max-utf8-bytes'], canvas.CANVAS_MAX_PARAMETERS_BYTES)
  assert.equal(schemas.Parameters!['x-max-depth'], canvas.CANVAS_MAX_PARAMETERS_DEPTH)
  assert.equal(schemas.Parameters!['x-max-json-values'], canvas.CANVAS_MAX_JSON_VALUES)
  assert.equal(schemas.CanvasOps!.maxItems, canvas.CANVAS_MAX_OPS)
  assert.equal(schemas.AgentUserRequest!.properties!.requireConfirmation!.default, canvas.CANVAS_AGENT_DEFAULT_REQUIRE_CONFIRMATION)
  const settings = schemas.UpdateCanvasAgentSettingsRequest!.properties!
  for (const [key, value] of Object.entries(canvas.CANVAS_AGENT_SETTINGS_DEFAULTS)) assert.equal(settings[key]!.default, value, key)
  for (const key of ['maxToolCallsPerTurn', 'maxJobsPerTurn', 'timeoutMs', 'maxAutoContinuations']) {
    const schema = settings[key]!
    for (const value of [schema.minimum!, schema.maximum!]) assert.equal(canvas.parseUpdateCanvasAgentSettingsRequest({ [key]: value }).success, true)
    for (const value of [schema.minimum! - 1, schema.maximum! + 1, schema.minimum! + 0.5]) assert.equal(canvas.parseUpdateCanvasAgentSettingsRequest({ [key]: value }).success, false)
  }
  const list = document.paths['/api/canvases']!.get!.parameters!
  const history = document.paths['/api/canvases/{id}/agent/history']!.get!.parameters!
  assert.deepEqual(list.find(item => item.name === 'limit')!.schema, { type: 'integer', minimum: 1, maximum: 100, default: 20 })
  assert.deepEqual(history.find(item => item.name === 'limit')!.schema, { type: 'integer', minimum: 1, maximum: 100, default: 50 })
  assert.deepEqual(history.find(item => item.name === 'afterSeq')!.schema, { type: 'integer', minimum: 0, maximum: 2147483647, default: 0 })
  const title = canvas.parseCreateCanvasRequest({ title: `  ${'x'.repeat(canvas.CANVAS_MAX_TITLE_LENGTH)}  ` })
  assert.ok(title.success)
  assert.equal(title.data.title.length, canvas.CANVAS_MAX_TITLE_LENGTH)
  const defaults = canvas.parseCreateCanvasRequest({})
  assert.ok(defaults.success)
  assert.deepEqual(defaults.data, { title: canvas.CANVAS_DEFAULT_TITLE, scene: schemas.CanvasScene!.default, coverAssetId: null })
  const user = canvas.parseCanvasAgentMessageRequest({ kind: 'user', messageId: uuid, text: 'Example', baseRevision: 1 })
  assert.ok(user.success)
  assert.equal(user.data.kind === 'user' && user.data.requireConfirmation, true)
})

test('canvas-openapi: all request/scene/op/parameter examples accepted, invalid examples rejected by actual parsers', () => {
  let accepted = 0, rejected = 0
  for (const [name, parse] of Object.entries(parsers)) {
    const schema = schemas[name]!
    assert.ok(schema.examples?.length, `${name} valid examples required`)
    assert.ok((schema['x-runtime-invalid-examples'] as unknown[])?.length, `${name} invalid examples required`)
    for (const value of schema.examples!) { assert.equal(parse(value).success, true, `${name}: ${JSON.stringify(value)}`); accepted++ }
    for (const value of schema['x-runtime-invalid-examples'] as unknown[]) { assert.equal(parse(value).success, false, `${name}: invalid ${JSON.stringify(value)}`); rejected++ }
  }
  assert.ok(accepted >= 20)
  assert.ok(rejected >= 25)
  for (const { operation } of operations) {
    const media = operation.requestBody?.content['application/json']
    if (!media) continue
    const name = media.schema.$ref!.split('/').at(-1)!
    assert.ok(parsers[name])
    for (const example of Object.values(media.examples!)) assert.equal(parsers[name]!(example.value).success, true, operation.operationId)
  }
  const saved = canvas.parseCanvasScene(schemas.CanvasScene!.examples![0])
  assert.ok(saved.success)
  const applied = canvas.applyCanvasOps(saved.data, schemas.CanvasOps!.examples![0])
  assert.ok(applied.success)
  assert.equal(canvas.parseUpdateCanvasRequest({ baseRevision: 2, scene: applied.data }).success, true)
})

test('canvas-openapi: pagination defaults/bounds and shared history budget agree with actual handlers', async () => {
  const context = (query = ''): AuthedContext => ({
    request: new NextRequest(`https://example.invalid/api/canvases/${uuid}/agent/history${query}`),
    actor: { id: uuid, role: 'user', status: 'active', email: 'example@example.invalid', createdAt: '2026-10-05T12:00:00.000Z' },
    path: `canvases/${uuid}/agent/history`, params: { id: uuid }, json: async () => ({}),
  })
  let seen: [number, number] | undefined
  const store = new class extends PgAgentStore {
    override async history(actorId: string, canvasId: string, afterSeq: number, limit: number) {
      seen = [afterSeq, limit]
      const timestamp = '2026-10-05T12:00:00.000Z'
      return { scope: { actorId, canvasId, sessionId: uuid },
        session: { id: uuid, canvasId, createdBy: actorId, requireConfirmation: true, nextSeq: 1,
          autoContinuationCount: 0, runningTurnId: null, runningLeaseToken: null, runningLeaseExpiresAt: null,
          createdAt: timestamp, updatedAt: timestamp },
        messages: [], nextAfterSeq: null, pending: [] }
    }
  }()
  const calls: Array<[string, number, number]> = []
  const handlers = createCanvasAgentHandlers({ store,
    chat: async () => { throw new Error('History must not call provider') },
    create: async () => { throw new Error('History must not create jobs') },
    limited: async (key, max, seconds) => { calls.push([key, max, seconds]); return false } })
  assert.equal((await handlers.history(context())).status, 200)
  const historyParams = document.paths['/api/canvases/{id}/agent/history']!.get!.parameters!
  assert.deepEqual(seen, [historyParams.find(item => item.name === 'afterSeq')!.schema.default,
    historyParams.find(item => item.name === 'limit')!.schema.default])
  assert.deepEqual(calls[0], [`canvas-agent:${uuid}`, 30, 60])
  assert.equal((await handlers.history(context('?afterSeq=2147483647&limit=100'))).status, 200)
  assert.deepEqual(seen, [2147483647, 100])
  for (const query of ['?limit=0', '?limit=101', '?afterSeq=-1', '?afterSeq=2147483648']) {
    seen = undefined
    assert.equal((await handlers.history(context(query))).status, 400)
    assert.equal(seen, undefined)
  }
  let sqlLimit: unknown
  // Only the repository's Pool.query port is used by list; never connect to a real database.
  const pool = { query: async (_sql: string, values: unknown[]) => { sqlLimit = values[1]; return { rows: [] } } } as unknown as pg.Pool
  const ports = { db: () => pool, limited: async () => { throw new Error('List has no mutation budget') } }
  assert.equal((await listCanvases(context(), ports)).status, 200)
  const listLimit = document.paths['/api/canvases']!.get!.parameters!.find(item => item.name === 'limit')!.schema
  assert.equal(sqlLimit, Number(listLimit.default) + 1) // Repository reads one extra row for nextCursor.
  assert.equal((await listCanvases(context('?limit=100'), ports)).status, 200)
  assert.equal(sqlLimit, Number(listLimit.maximum) + 1)
  for (const query of ['?limit=0', '?limit=101', '?limit=01', '?limit=20&limit=20']) {
    sqlLimit = undefined
    assert.equal((await listCanvases(context(query), ports)).status, 400)
    assert.equal(sqlLimit, undefined)
  }
  const limitedHandlers = createCanvasAgentHandlers({ store,
    chat: async () => { throw new Error('Unexpected provider') }, create: async () => { throw new Error('Unexpected generation') },
    limited: async () => true })
  const failure = await limitedHandlers.history(context())
  assert.equal(failure.status, 429)
  assert.deepEqual((await failure.json()).error.code, 'CANVAS_AGENT_RATE_LIMITED')
  assert.match(document.info.description, /fail OPEN/)
})

test('canvas-openapi: documented Origin semantics use host candidates, not a CSRF token or Bearer', () => {
  const request = (headers: Record<string, string>) => new NextRequest('https://example.invalid/api/canvases', { headers })
  assert.equal(mutationOriginValid(request({})), true)
  assert.equal(mutationOriginValid(request({ origin: '', host: 'example.invalid' })), true)
  assert.equal(mutationOriginValid(request({ origin: 'http://EXAMPLE.invalid:443', host: 'example.invalid:443' })), true)
  assert.equal(mutationOriginValid(request({ origin: 'https://example.invalid', 'x-forwarded-host': 'forged.invalid, example.invalid' })), true)
  assert.equal(mutationOriginValid(request({ origin: 'https://forged.invalid', 'x-forwarded-host': 'forged.invalid, example.invalid' })), false)
  assert.equal(mutationOriginValid(request({ origin: 'not a URL', host: 'example.invalid' })), false)
  assert.match(document.info.description, /rightmost nonempty X-Forwarded-Host/)
  assert.match(document.info.description, /Scheme not compared/)
  assert.match(document.info.description, /no CSRF token/)
})

test('canvas-openapi: all eight SSE frames match discriminator, UUID IDs and actual serializer', async () => {
  const response = document.paths['/api/canvases/{id}/agent/messages']!.post!.responses['200']!
  assert.deepEqual(Object.keys(response.content), ['text/event-stream'])
  const media = response.content['text/event-stream']!
  assert.deepEqual(media.schema, { type: 'string' })
  assert.deepEqual(media['x-event-schema'], { $ref: '#/components/schemas/AgentStreamEvent' })
  assert.deepEqual(media['x-comment-examples'], [': connected\n\n', ': heartbeat\n\n'])
  const events: canvas.AgentStreamEvent[] = []
  const ids = new Set<string>()
  assert.deepEqual(Object.keys(media.examples!), Object.keys(schemas.AgentStreamEvent!.discriminator!.mapping))
  for (const [type, example] of Object.entries(media.examples!)) {
    assert.equal(typeof example.value, 'string')
    const lines = (example.value as string).split('\n')
    assert.deepEqual([lines[0], ...lines.slice(2)], [`event: ${type}`, '', ''])
    assert.ok(lines[1]!.startsWith('data: '))
    const event = JSON.parse(lines[1]!.slice(6)) as canvas.AgentStreamEvent
    assert.equal(event.type, type)
    assert.ok(matches(event, schemas.AgentStreamEvent!))
    assert.ok(canvas.isCanvasUuid(event.turnId)); assert.ok(canvas.isCanvasUuid(event.eventId))
    assert.equal(ids.has(event.eventId), false); ids.add(event.eventId)
    assert.deepEqual(schemas[`AgentEvent_${type}`]!.examples, [event])
    events.push(event)
  }
  let cleaned = false
  const stream = agentStream({ signal: new AbortController().signal, timeoutMs: 1000,
    run: async send => { for (const event of events) send(event) }, cleanup: async () => { cleaned = true } })
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  assert.equal(stream.headers.get('cache-control'), 'no-cache, no-transform')
  assert.equal(stream.headers.get('x-accel-buffering'), 'no')
  assert.equal(await stream.text(), ': connected\n\n' + Object.values(media.examples!).map(item => item.value).join(''))
  assert.equal(cleaned, true)
})
