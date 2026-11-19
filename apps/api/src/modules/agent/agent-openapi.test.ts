import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  API_ENDPOINTS, type AgentSessionSnapshotDTO, type AgentToolSummaryDTO, type AgentApprovalSummaryDTO,
  type AgentArtifactDTO, type AgentArtifactPageDTO, type AgentArtifactThreadsPageDTO, type AgentArtifactThreadDTO,
  type AgentArtifactAnchor, type CreateAgentArtifactThreadRequest, type CreateAgentArtifactReplyRequest, type ResolveAgentArtifactThreadRequest,
} from '@musecanvas/contracts'
import { GET_ROUTES, POST_ROUTES, PATCH_ROUTES, DELETE_ROUTES } from '../../router/routes'
import {
  AgentCoreError, agentCoreDecimal, artifactAnchor, artifactIdentity, artifactPageQuery, artifactThreadInput,
  artifactReplyInput, artifactResolveInput, encodeArtifactCursor, decodeArtifactCursor, validateArtifactAnchor,
} from '@musecanvas/database'
import { approvalInput, createSessionInput, eventCursor, messageInput, pageQuery } from './validation'

type Node = Record<string, any>
const document: Node = JSON.parse(readFileSync(new URL('../../../../../docs/agent-core-openapi.json', import.meta.url), 'utf8'))
const schemas = document.components.schemas
const id = '123e4567-e89b-12d3-a456-426614174000'
function resolve(node: Node): Node {
  if (!node.$ref) return node
  let current: Node = document
  for (const part of String(node.$ref).replace(/^#\//, '').split('/')) current = current[part]
  assert.ok(current, `missing reference ${node.$ref}`)
  return current
}
const operations = Object.entries(document.paths as Node).flatMap(([path, methods]) => Object.entries(methods as Node).map(([method, operation]) => ({ path, method: method.toUpperCase(), operation: operation as Node })))
const routes = [['GET', GET_ROUTES], ['POST', POST_ROUTES], ['PATCH', PATCH_ROUTES], ['DELETE', DELETE_ROUTES]] as const

test('agent-openapi: every actual Core method/path and endpoint are declared exactly once, with no pending route exception', () => {
  const actual = routes.flatMap(([method, table]) => table.filter(route => route.path.startsWith('agent/')).map(route => `${method} /api/${route.path.replaceAll(':id', '{id}').replaceAll(':artifactId', '{artifactId}').replaceAll(':threadId', '{threadId}')}`)).sort()
  const declared = operations.map(o => `${o.method} ${o.path}`).sort()
  assert.deepEqual(declared, actual)
  assert.equal(declared.length, 17)
  const endpointPaths = Object.values(API_ENDPOINTS.agent).map(value => typeof value === 'function' ? decodeURIComponent(value('{id}', '{artifactId}', '{threadId}')) : value)
  assert.deepEqual([...new Set(operations.map(o => o.path))].sort(), [...new Set(endpointPaths)].sort())
  assert.equal(new Set(operations.map(o => o.operation.operationId)).size, 17)
})
test('agent-openapi: root spec imports the same Core paths and components', () => {
  const root: Node = JSON.parse(readFileSync(new URL('../../../../../openapi.yml', import.meta.url), 'utf8'))
  const imported = (value: unknown) => JSON.parse(JSON.stringify(value).replace(
    /#\/components\/(schemas|parameters|responses|requestBodies)\/([\w]+)/g, '#/components/$1/AgentCore$2',
  ))
  assert.deepEqual(Object.keys(root.paths).filter(path => path.startsWith('/api/agent/')).sort(), Object.keys(document.paths).sort())
  for (const [path, methods] of Object.entries(document.paths as Node)) {
    for (const [method, operation] of Object.entries(methods as Node)) {
      assert.deepEqual(root.paths[path][method], { ...imported(operation), 'x-access': 'public' })
    }
  }
  for (const kind of ['schemas', 'parameters', 'responses', 'requestBodies']) {
    for (const [name, value] of Object.entries(document.components[kind] as Node)) {
      assert.deepEqual(root.components[kind][`AgentCore${name}`], imported(value))
    }
  }
  assert.deepEqual(root.security, [{ museSession: [] }])
  assert.equal(root.components.securitySchemes.museSession.name, document.components.securitySchemes.sessionCookie.name)
})

test('agent-openapi: complete local references and cookie auth, JSON success/failure envelopes and typed mutation bodies', () => {
  assert.equal(document.openapi, '3.1.0')
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    const object = node as Node
    if (object.$ref) { assert.match(object.$ref, /^#\/components\//); resolve(object) }
    Object.values(object).forEach(visit)
  }
  visit(document)
  assert.deepEqual(document.security, [{ sessionCookie: [] }])
  assert.deepEqual(document.components.securitySchemes.sessionCookie, { type: 'apiKey', in: 'cookie', name: 'muse_session' })
  for (const { path, method, operation } of operations) {
    assert.equal(operation.security, undefined, `${method} ${path} must inherit cookie authentication`)
    for (const status of ['400', '401', '403', '404', '429', '503']) assert.ok(operation.responses[status], `${method} ${path} missing ${status}`)
    assert.match(operation.description, /Feature-disabled namespace returns 404 before authentication, DB or rate Redis/)
    const success = resolve(operation.responses[method === 'POST' ? '202' : '200'])
    if (!path.endsWith('/events')) {
      const schema = resolve(success.content['application/json'].schema)
      assert.equal(schema.properties.success.const, true); assert.ok(schema.properties.data)
    }
    if (method === 'POST' || method === 'PATCH') {
      const body = resolve(operation.requestBody)
      assert.equal(body.required, true)
      const schema = resolve(body.content['application/json'].schema)
      assert.equal(schema.additionalProperties, false)
      assert.match(operation.description, /40000 bytes/)
      if (method === 'POST') assert.match(operation.description, /sole authority/)
    }
    const missing = resolve(operation.responses['404'])
    assert.equal(resolve(missing.content['application/json'].schema).properties.success.const, false)
  }
})
test('agent-openapi: DTO summary/snapshot field sets match typed contracts and never add execution config or lease secrets', () => {
  const snapshot = { session: true, activeTurn: true, items: true, eventCursor: true, lastItemSequence: true, itemsHasMore: true, nextItemsCursor: true,
    tools: true, approvals: true, summariesTruncated: true } satisfies Record<keyof AgentSessionSnapshotDTO, true>
  const tool = { id: true, turnId: true, toolName: true, status: true, revision: true } satisfies Record<keyof AgentToolSummaryDTO, true>
  const approval = { id: true, sessionId: true, turnId: true, toolCallId: true, argumentsHash: true, modelRevision: true, pricingRevision: true,
    reservationId: true, status: true, expiresAt: true, resolvedBy: true, resolvedAt: true, revision: true } satisfies Record<keyof AgentApprovalSummaryDTO, true>
  for (const [name, expected] of [['Snapshot', snapshot], ['ToolSummary', tool], ['ApprovalSummary', approval]] as const) {
    assert.deepEqual(Object.keys(schemas[name].properties).sort(), Object.keys(expected).sort())
    assert.deepEqual([...schemas[name].required].sort(), Object.keys(expected).sort())
  }
  assert.equal(schemas.ToolSummary.properties.arguments, undefined)
  assert.equal(schemas.Turn.properties.configSnapshot, undefined)
  assert.equal(schemas.Turn.properties.leaseOwner, undefined)
  assert.equal(schemas.Decimal.type, 'string'); assert.match(schemas.Decimal.description, /9223372036854775807/)
  assert.match(schemas.ApprovalSummary.description, /not an independent approval counter/)
})
test('agent-openapi: Decimal schema has exact PostgreSQL int64 bounds and Message advertises the UTF-8 byte ceiling', () => {
  const decimal = schemas.Decimal
  const pattern = new RegExp(decimal.pattern)
  const samples = new Set(['0', '1', '9223372036854775807', '9223372036854775808', '9999999999999999999', '01', '-1', '1e3', ' 1', '', '0'.repeat(19), '1'.repeat(20)])
  const maximum = 9223372036854775807n
  for (let offset = -100n; offset <= 100n; offset++) samples.add((maximum + offset).toString())
  // Check both sides of every decimal-prefix branch, not just max and max+1.
  const digits = maximum.toString()
  for (let index = 0; index < digits.length; index++) {
    for (let digit = 0; digit <= 9; digit++) {
      for (const suffix of ['0', '9']) samples.add(digits.slice(0, index) + digit + suffix.repeat(digits.length - index - 1))
    }
  }
  for (let length = 1; length <= 20; length++) samples.add('9'.repeat(length))
  for (const value of samples) {
    const valid = /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= maximum
    assert.equal(pattern.test(value), valid, `schema: ${value}`)
    if (valid) {
      assert.equal(agentCoreDecimal(value), value)
      assert.equal(pageQuery(new URL(`https://example.invalid?cursor=${value}`), 'items').cursor, value)
    } else assert.throws(() => agentCoreDecimal(value), AgentCoreError)
  }
  const schema = schemas.Message.properties.content
  assert.equal(schema['x-maxUtf8Bytes'], 32000)
  const exact = '你'.repeat(10666) + 'ab'
  assert.equal(Buffer.byteLength(exact, 'utf8'), 32000)
  assert.equal(messageInput({ clientMessageId: id, content: exact }).content, exact)
  assert.equal(messageInput({ clientMessageId: id, content: 'x'.repeat(32000) }).content.length, 32000)
  assert.throws(() => messageInput({ clientMessageId: id, content: 'x'.repeat(32001) }), AgentCoreError)
  const content = exact + 'c'
  assert.equal([...content].length <= schema.maxLength, true, 'ordinary JSON Schema character limit still passes')
  assert.equal(Buffer.byteLength(content, 'utf8'), schema['x-maxUtf8Bytes'] + 1)
  assert.match(schema.description, /multibyte string may pass maxLength and still be rejected/)
  assert.throws(() => messageInput({ clientMessageId: id, content }), AgentCoreError)
})

test('agent-openapi: request examples, strict pagination bounds and SSE frame discriminators agree with real parsers', () => {
  assert.equal(createSessionInput({ clientRequestId: 'create-1', agentDefinitionId: id, definitionVersion: 1 }).clientRequestId, 'create-1')
  assert.equal(messageInput({ clientMessageId: id, content: 'hello' }).content, 'hello')
  assert.equal(approvalInput({ decision: 'approved', expectedArgumentsHash: 'a'.repeat(64) }).decision, 'approved')
  assert.deepEqual(schemas.Message.required, ['clientMessageId', 'content'])
  assert.deepEqual(schemas.Approval.properties.decision.enum, ['approved', 'rejected'])
  assert.deepEqual(document.components.parameters.Limit.schema, { type: 'integer', minimum: 1, maximum: 100, default: 50 })
  assert.equal(pageQuery(new URL('https://example.invalid'), 'items').limit, 50)
  for (const value of ['0', '101', '1.5', '01']) assert.throws(() => pageQuery(new URL(`https://example.invalid?limit=${value}`), 'items'))
  const events = operations.find(o => o.path.endsWith('/events'))!.operation
  assert.ok(resolve(events.responses['200']).content['text/event-stream'])
  assert.match(events.description, /must equal query cursor/); assert.match(events.description, /Reconnect with last delivered ID/)
  assert.match(events.description, /25s/); assert.match(events.description, /500 durable events/)
  assert.throws(() => eventCursor(id, '2', `${id}:1`), { code: 'CONFLICT' })
  assert.equal(eventCursor(id, '9007199254740993', `${id}:9007199254740993`), '9007199254740993')
  assert.deepEqual(schemas.DisplayEvent.oneOf.map((x: Node) => x.properties.type.const).sort(), ['item.created', 'turn.updated', 'tool.updated', 'approval.required'].sort())
  assert.deepEqual(schemas.TransportFrame.oneOf.map((x: Node) => x.properties.type.const).sort(), ['ready', 'heartbeat', 'resync.required'].sort())
  const approval = operations.find(o => o.path.endsWith('/resolve'))!.operation
  const conflict = resolve(approval.responses['409'])
  assert.ok(conflict.content['application/json'].schema.oneOf.some((x: Node) => x.$ref.endsWith('/ApprovalExpired')))
})

test('agent-openapi: seven Artifact methods declare exact status, scope parameters, envelopes and mutation bodies', () => {
  const base = '/api/agent/sessions/{id}/artifacts'
  const expected = [
    ['GET', base, '200', 'ArtifactPage'],
    ['GET', `${base}/{artifactId}`, '200', 'Artifact'],
    ['GET', `${base}/{artifactId}/threads`, '200', 'ArtifactThreadsPage'],
    ['GET', `${base}/{artifactId}/threads/{threadId}`, '200', 'ArtifactThread'],
    ['POST', `${base}/{artifactId}/threads`, '202', 'ArtifactThread', 'CreateArtifactThread'],
    ['POST', `${base}/{artifactId}/threads/{threadId}/replies`, '202', 'ArtifactThread', 'CreateArtifactReply'],
    ['PATCH', `${base}/{artifactId}/threads/{threadId}`, '200', 'ArtifactThread', 'ResolveArtifactThread'],
  ] as const
  assert.equal(operations.filter(o => o.path.includes('/artifacts')).length, expected.length)
  for (const [method, path, status, response, body] of expected) {
    const operation = operations.find(o => o.method === method && o.path === path)!.operation
    assert.deepEqual(Object.keys(operation.responses).filter(code => code.startsWith('2')), [status])
    assert.equal(operation.responses[status].$ref, `#/components/responses/${response}`)
    const envelope = resolve(resolve(operation.responses[status]).content['application/json'].schema)
    assert.deepEqual(envelope.required, ['success', 'data'])
    assert.equal(envelope.additionalProperties, false)
    assert.equal(envelope.properties.data.$ref, `#/components/schemas/${response}`)
    const parameters = operation.parameters.map(resolve)
    assert.deepEqual(parameters.filter((p: Node) => p.in === 'path').map((p: Node) => p.name).sort(), [...path.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort())
    assert.ok(parameters.filter((p: Node) => p.in === 'path').every((p: Node) => p.required === true))
    assert.deepEqual(parameters.filter((p: Node) => p.in === 'header').map((p: Node) => p.name).sort(), ['Idempotency-Key', 'Last-Event-ID'])
    const paginated = path === base || method === 'GET' && path.endsWith('/threads')
    assert.deepEqual(parameters.filter((p: Node) => p.in === 'query').map((p: Node) => p.name).sort(), paginated ? ['cursor', 'limit'] : [])
    assert.equal(operation.requestBody?.$ref, body ? `#/components/requestBodies/${body}` : undefined)
    assert.equal(Boolean(operation.responses['409']), method === 'POST')
    if (method !== 'GET') assert.match(operation.description, /Same-origin validation required/)
  }
})

test('agent-openapi: Artifact, thread, page and mutation field sets agree with shared DTOs', () => {
  const base = { sessionId: true, turnId: true, sourceItemId: true, version: true, createdAt: true } as const
  const text = { ...base, id: true, kind: true, content: true } satisfies Record<keyof Extract<AgentArtifactDTO, { kind: 'text' }>, true>
  const media = { ...base, id: true, kind: true, assetId: true, available: true, width: true, height: true, durationMs: true } satisfies Record<keyof Extract<AgentArtifactDTO, { kind: 'image' | 'video' }>, true>
  const thread = { id: true, artifactId: true, version: true, anchor: true, resolved: true, resolvedAt: true, messages: true, createdAt: true } satisfies Record<keyof AgentArtifactThreadDTO, true>
  const message = { id: true, body: true, createdAt: true } satisfies Record<keyof AgentArtifactThreadDTO['messages'][number], true>
  const page = { items: true, nextCursor: true } satisfies Record<keyof AgentArtifactPageDTO | keyof AgentArtifactThreadsPageDTO, true>
  const create = { clientRequestId: true, version: true, anchor: true, body: true } satisfies Record<keyof CreateAgentArtifactThreadRequest, true>
  const reply = { clientRequestId: true, body: true } satisfies Record<keyof CreateAgentArtifactReplyRequest, true>
  const resolveRequest = { resolved: true } satisfies Record<keyof ResolveAgentArtifactThreadRequest, true>
  for (const [name, expected] of [['TextArtifact', text], ['MediaArtifact', media], ['ArtifactThread', thread], ['ArtifactThreadMessage', message], ['ArtifactPage', page], ['ArtifactThreadsPage', page], ['CreateArtifactThread', create], ['CreateArtifactReply', reply], ['ResolveArtifactThread', resolveRequest]] as const) {
    assert.deepEqual(Object.keys(schemas[name].properties).sort(), Object.keys(expected).sort(), name)
    assert.deepEqual([...schemas[name].required].sort(), Object.keys(expected).sort(), name)
    assert.equal(schemas[name].additionalProperties, false, name)
  }
  assert.deepEqual(schemas.Artifact.oneOf, [{ $ref: '#/components/schemas/TextArtifact' }, { $ref: '#/components/schemas/MediaArtifact' }])
  assert.equal(schemas.TextArtifact.properties.kind.const, 'text')
  assert.deepEqual(schemas.MediaArtifact.properties.kind.enum, ['image', 'video'])
  for (const name of ['TextArtifact', 'MediaArtifact', 'ArtifactThread', 'CreateArtifactThread']) assert.equal(schemas[name].properties.version.const, 1)
  assert.equal(schemas.ArtifactThread.properties.messages.maxItems, 100)
  assert.deepEqual(schemas.ResolveArtifactThread.properties.resolved, { type: 'boolean' })
})

test('agent-openapi: Artifact pagination, identity and mutation byte bounds match runtime parsers', () => {
  const cursorSchema = schemas.ArtifactCursor
  assert.deepEqual([cursorSchema.minLength, cursorSchema.maxLength], [1, 512])
  assert.deepEqual(document.components.parameters.ArtifactCursor.schema, { $ref: '#/components/schemas/ArtifactCursor' })
  for (const name of ['ArtifactPage', 'ArtifactThreadsPage']) {
    assert.equal(schemas[name].properties.items.maxItems, 100)
    assert.deepEqual(schemas[name].properties.nextCursor, { anyOf: [{ $ref: '#/components/schemas/ArtifactCursor' }, { type: 'null' }] })
  }
  assert.deepEqual(artifactPageQuery(new URL('https://example.invalid')), { limit: 50, cursor: undefined })
  assert.equal(artifactPageQuery(new URL('https://example.invalid?limit=100')).limit, 100)
  for (const query of ['limit=0', 'limit=101', 'limit=01', 'limit=1.5', 'limit=1&limit=2', 'cursor=', `cursor=${'a'.repeat(513)}`, 'owner=other', `unknown=${'a'.repeat(1024)}`]) {
    assert.throws(() => artifactPageQuery(new URL(`https://example.invalid?${query}`)), AgentCoreError)
  }
  const artifactId = `text:${id}`
  for (const value of [artifactId, `MEDIA:${id.toUpperCase()}`]) {
    assert.match(value, new RegExp(schemas.ArtifactId.pattern))
    assert.equal(artifactIdentity(value), value.toLowerCase())
  }
  for (const value of ['text:bad', `text:${id}:extra`, `image:${id}`, `text:${id}/extra`]) {
    assert.doesNotMatch(value, new RegExp(schemas.ArtifactId.pattern))
    assert.throws(() => artifactIdentity(value), AgentCoreError)
  }
  for (const kind of ['artifacts', 'threads'] as const) {
    const scope = { kind, sessionId: id, ...(kind === 'threads' ? { artifactId } : {}), sequence: '1', id: kind === 'threads' ? id : artifactId }
    const cursor = encodeArtifactCursor(scope)
    assert.match(cursor, new RegExp(cursorSchema.pattern))
    assert.ok(cursor.length <= cursorSchema.maxLength)
    assert.deepEqual(decodeArtifactCursor(cursor, kind, id, scope.artifactId), scope)
    assert.throws(() => decodeArtifactCursor(cursor, kind === 'threads' ? 'artifacts' : 'threads', id), AgentCoreError)
    assert.throws(() => decodeArtifactCursor(cursor, kind, '223e4567-e89b-12d3-a456-426614174000', scope.artifactId), AgentCoreError)
  }
  for (const name of ['CreateArtifactThread', 'CreateArtifactReply']) {
    assert.deepEqual(schemas[name].properties.clientRequestId, { $ref: '#/components/schemas/Uuid' })
    assert.deepEqual(schemas[name].properties.body, { $ref: '#/components/schemas/ArtifactMessageBody' })
  }
  const bodySchema = schemas.ArtifactMessageBody
  assert.equal(bodySchema['x-maxUtf8Bytes'], 8000)
  const exact = '你'.repeat(2666) + 'ab'
  assert.equal(Buffer.byteLength(exact), 8000)
  assert.equal(artifactReplyInput({ clientRequestId: id, body: exact }).body, exact)
  assert.equal(artifactThreadInput({ clientRequestId: id, version: 1, anchor: { kind: 'whole' }, body: exact }).body, exact)
  assert.ok([...exact + 'c'].length <= bodySchema.maxLength)
  for (const body of [exact + 'c', 'x'.repeat(8001), '', ' ', '\0', '\uD800']) {
    assert.throws(() => artifactReplyInput({ clientRequestId: id, body }), AgentCoreError)
    assert.throws(() => artifactThreadInput({ clientRequestId: id, version: 1, anchor: { kind: 'whole' }, body }), AgentCoreError)
  }
  for (const request of [{ clientRequestId: 'bad', body: 'comment' }, { clientRequestId: id, body: 'comment', extra: true }]) assert.throws(() => artifactReplyInput(request), AgentCoreError)
  assert.throws(() => artifactThreadInput({ clientRequestId: id, version: 2, anchor: { kind: 'whole' }, body: 'comment' }), AgentCoreError)
  for (const resolved of [true, false]) assert.deepEqual(artifactResolveInput({ resolved }), { resolved })
  for (const request of [{}, { resolved: 'true' }, { resolved: true, clientRequestId: id }]) assert.throws(() => artifactResolveInput(request), AgentCoreError)
})

test('agent-openapi: strict Artifact anchor union documents geometric and UTF-16 bounds', () => {
  const fields = {
    whole: { kind: true } satisfies Record<keyof Extract<AgentArtifactAnchor, { kind: 'whole' }>, true>,
    text: { kind: true, start: true, end: true, quote: true } satisfies Record<keyof Extract<AgentArtifactAnchor, { kind: 'text' }>, true>,
    image_point: { kind: true, x: true, y: true } satisfies Record<keyof Extract<AgentArtifactAnchor, { kind: 'image_point' }>, true>,
    image_rect: { kind: true, x: true, y: true, width: true, height: true } satisfies Record<keyof Extract<AgentArtifactAnchor, { kind: 'image_rect' }>, true>,
    video: { kind: true, timeMs: true } satisfies Record<keyof Extract<AgentArtifactAnchor, { kind: 'video' }>, true>,
  }
  const branches = Object.fromEntries(schemas.ArtifactAnchor.oneOf.map((branch: Node) => [branch.properties.kind.const, branch])) as Record<keyof typeof fields, Node>
  assert.deepEqual(Object.keys(branches).sort(), Object.keys(fields).sort())
  for (const kind of Object.keys(fields) as (keyof typeof fields)[]) {
    assert.equal(branches[kind].additionalProperties, false)
    assert.deepEqual(Object.keys(branches[kind].properties).sort(), Object.keys(fields[kind]).sort())
    assert.deepEqual([...branches[kind].required].sort(), Object.keys(fields[kind]).sort())
  }
  for (const [kind, key] of [['text', 'start'], ['text', 'end'], ['video', 'timeMs']] as const) {
    assert.equal(branches[kind].properties[key].type, 'integer')
    assert.equal(branches[kind].properties[key].minimum, key === 'end' ? 1 : 0)
    assert.equal(branches[kind].properties[key].maximum, Number.MAX_SAFE_INTEGER)
  }
  assert.match(branches.text.description, /UTF-16/)
  assert.equal(branches.text.properties.quote['x-maxUtf8Bytes'], 32000)
  for (const kind of ['image_point', 'image_rect'] as const) for (const key of ['x', 'y']) assert.deepEqual(branches[kind].properties[key], { type: 'number', minimum: 0, maximum: 1 })
  for (const key of ['width', 'height']) assert.deepEqual(branches.image_rect.properties[key], { type: 'number', exclusiveMinimum: 0, maximum: 1 })
  const base = { sessionId: id, turnId: id, sourceItemId: id, version: 1 as const, createdAt: '2026-11-19T00:00:00.000Z' }
  const text: AgentArtifactDTO = { ...base, id: `text:${id}`, kind: 'text', content: 'a😀b' }
  const image: AgentArtifactDTO = { ...base, id: `media:${id}`, kind: 'image', assetId: id, available: false, width: null, height: null, durationMs: null }
  const video: AgentArtifactDTO = { ...image, kind: 'video', durationMs: 1000 }
  const samples: [AgentArtifactDTO, AgentArtifactAnchor][] = [[text, { kind: 'whole' }], [text, { kind: 'text', start: 1, end: 3, quote: '😀' }], [image, { kind: 'image_point', x: 0, y: 1 }], [image, { kind: 'image_rect', x: 0.25, y: 0.25, width: 0.75, height: 0.75 }], [video, { kind: 'video', timeMs: 1000 }]]
  for (const [artifact, anchor] of samples) assert.deepEqual(validateArtifactAnchor(artifact, anchor), anchor)
  for (const anchor of [{ kind: 'whole', extra: true }, { kind: 'text', start: 1, end: 1, quote: 'a' }, { kind: 'image_point', x: -0.1, y: 0 }, { kind: 'image_rect', x: 0, y: 0, width: 0, height: 1 }, { kind: 'image_rect', x: 0.5, y: 0, width: 0.6, height: 1 }, { kind: 'video', timeMs: 0.5 }, { kind: 'video', timeMs: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => artifactAnchor(anchor), AgentCoreError)
  for (const [artifact, anchor] of [[text, { kind: 'text', start: 1, end: 2, quote: '\uD83D' }], [text, { kind: 'text', start: 1, end: 3, quote: 'wrong' }], [image, { kind: 'video', timeMs: 0 }], [video, { kind: 'video', timeMs: 1001 }], [{ ...video, durationMs: null }, { kind: 'video', timeMs: 0 }]] as const) assert.throws(() => validateArtifactAnchor(artifact, anchor), AgentCoreError)
})
