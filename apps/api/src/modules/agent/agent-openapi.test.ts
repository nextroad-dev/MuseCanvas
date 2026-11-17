import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { API_ENDPOINTS, type AgentSessionSnapshotDTO, type AgentToolSummaryDTO, type AgentApprovalSummaryDTO } from '@musecanvas/contracts'
import { GET_ROUTES, POST_ROUTES, PATCH_ROUTES, DELETE_ROUTES } from '../../router/routes'
import { AgentCoreError, agentCoreDecimal } from '@musecanvas/database'
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
  const actual = routes.flatMap(([method, table]) => table.filter(route => route.path.startsWith('agent/')).map(route => `${method} /api/${route.path.replaceAll(':id', '{id}')}`)).sort()
  const declared = operations.map(o => `${o.method} ${o.path}`).sort()
  assert.deepEqual(declared, actual)
  assert.equal(declared.length, 10)
  const endpointPaths = Object.values(API_ENDPOINTS.agent).map(value => typeof value === 'function' ? value(id).replace(id, '{id}') : value)
  assert.deepEqual([...new Set(operations.map(o => o.path))].sort(), [...new Set(endpointPaths)].sort())
  assert.equal(new Set(operations.map(o => o.operation.operationId)).size, 10)
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
  assert.equal(document.components.securitySchemes.sessionCookie.name, 'muse_session')
  for (const { path, method, operation } of operations) {
    for (const status of ['400', '401', '403', '404', '429', '503']) assert.ok(operation.responses[status], `${method} ${path} missing ${status}`)
    assert.match(operation.description, /Feature-disabled namespace returns 404 before authentication, DB or rate Redis/)
    const success = resolve(operation.responses[method === 'POST' ? '202' : '200'])
    if (!path.endsWith('/events')) {
      const schema = resolve(success.content['application/json'].schema)
      assert.equal(schema.properties.success.const, true); assert.ok(schema.properties.data)
    }
    if (method === 'POST') {
      const body = resolve(operation.requestBody)
      assert.equal(body.required, true)
      const schema = resolve(body.content['application/json'].schema)
      assert.equal(schema.additionalProperties, false)
      assert.match(operation.description, /40000 bytes/)
      assert.match(operation.description, /sole authority/)
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
