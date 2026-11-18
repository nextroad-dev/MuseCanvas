import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLanguageModelChatRequest, parseLanguageModelChatResponse } from '@musecanvas/providers'
import { createReadonlyAgentTools, createReadonlyToolRegistry, readonlyTools } from './readonly'
import type { AgentSqlClient, AgentTool, AgentToolContext, AgentToolRegistry } from '../ports'
import { createAgentToolRegistry, fromModelToolName, MAX_TOOL_OUTPUT_BYTES, toModelToolName, ToolRegistry, ToolValidationError, toolVersionKey, validateToolArguments, validateToolSchema, type InstalledTool, type ToolContext, type ToolSchema } from './registry'

const ownerId = '11111111-1111-4111-8111-111111111111'
const context: ToolContext = { ownerId, query: { async query() { throw new Error('Unexpected query') } } }
const empty: ToolSchema = { type: 'object', properties: {}, required: [], additionalProperties: false }
const media = (version = 1): InstalledTool => ({ name: 'generate_image', schemaVersion: version, parameters: structuredClone(empty),
  description: 'Submit through the injected media service', permissions: ['media:submit'], execution: 'media_async',
  async execute() { return { kind: 'pending', jobIds: [ownerId] } } })
const code = (expected: string) => (error: unknown) => error instanceof ToolValidationError && error.code === expected

test('registry advertises only installed allowed versions with reversible provider-safe names', () => {
  const registry = createReadonlyToolRegistry()
  assert.deepEqual(registry.listDefinitions().map(tool => toolVersionKey(tool.name, tool.schemaVersion)), ['list_models@v1', 'search_assets@v1', 'get_asset@v1', 'get_canvas@v1'])
  for (const tool of registry.listModelTools()) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/)
    const parsed = fromModelToolName(tool.name)
    assert.equal(toModelToolName(parsed.name, parsed.schemaVersion), tool.name)
  }
  // Exercise the provider's pure request/response validation without transport.
  const request = buildLanguageModelChatRequest({ protocol: 'openai_chat', apiKey: 'test', vendorModelId: 'test', system: 'test', maxOutputTokens: 100, timeoutMs: 1000,
    messages: [{ role: 'user', content: 'hello' }], tools: registry.listModelTools() })
  assert.ok(Array.isArray(request.body.tools))
  const response = parseLanguageModelChatResponse('openai_chat', { choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_canvas__v1', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }, registry.listModelTools())
  assert.deepEqual(registry.validateModelCall(response.toolCalls[0].name, response.toolCalls[0].arguments), { toolName: 'get_canvas', schemaVersion: 1, arguments: {} })
})

test('allowlist, exact version and installed handlers are checked on every backend/model path', async () => {
  const registry = createReadonlyToolRegistry({ allowlist: ['get_asset@v1'] })
  assert.deepEqual(registry.listDefinitions().map(tool => tool.name), ['get_asset'])
  assert.throws(() => registry.validate('get_canvas', 1, {}), code('TOOL_NOT_ALLOWED'))
  assert.throws(() => registry.validate('get_asset', 2, { assetId: ownerId }), code('UNKNOWN_TOOL'))
  for (const name of ['get_asset', 'get_asset@v1', 'get_asset__v01', 'get_asset__v0', 'http__v1', 'get_asset__v9999999']) {
    assert.throws(() => registry.validateModelCall(name, { assetId: ownerId }), ToolValidationError)
  }
  await assert.rejects(registry.dispatch(context, { toolName: 'get_canvas', schemaVersion: 1, arguments: {} }), code('TOOL_NOT_ALLOWED'))
  await assert.rejects(registry.dispatch(context, { toolName: 'get_asset', schemaVersion: 1, arguments: { assetId: ownerId, ownerId } }), code('INVALID_ARGUMENTS'))
  assert.throws(() => createReadonlyToolRegistry({ allowlist: ['generate_video@v1'] }), code('UNKNOWN_TOOL'))
  assert.throws(() => createReadonlyToolRegistry({ allowlist: ['get_canvas@v1', 'get_canvas@v1'] }), code('INVALID_REGISTRATION'))
})

test('separate media registration supports explicit versions and rejects arbitrary execution tools', async () => {
  const registry = createReadonlyToolRegistry({ mediaTools: [media(), media(2)], allowlist: ['generate_image@v2'] })
  assert.deepEqual(registry.listModelTools().map(tool => tool.name), ['generate_image__v2'])
  assert.throws(() => registry.validate('generate_image', 1, {}), code('TOOL_NOT_ALLOWED'))
  assert.deepEqual(await registry.dispatch(context, registry.validateModelCall('generate_image__v2', {})), { kind: 'pending', jobIds: [ownerId] })
  for (const name of ['sql', 'http', 'shell', 'file', 'get_asset']) {
    assert.throws(() => createReadonlyToolRegistry({ mediaTools: [{ ...media(), name }] }), code('INVALID_REGISTRATION'))
  }
  assert.throws(() => createReadonlyToolRegistry({ mediaTools: [media(), media()] }), code('INVALID_REGISTRATION'))
  assert.throws(() => new ToolRegistry({ tools: [{ ...readonlyTools()[0], schemaVersion: 2 }], allowlist: [] }), code('INVALID_REGISTRATION'))
  assert.throws(() => new ToolRegistry({ tools: [readonlyTools()[0], readonlyTools()[0]], allowlist: [] }), code('INVALID_REGISTRATION'))
})

test('definition copies and source schema mutation cannot change installed validation', () => {
  const installed = media()
  const registry = createReadonlyToolRegistry({ mediaTools: [installed], allowlist: ['generate_image@v1'] })
  installed.parameters.properties!.injected = { type: 'string', maxLength: 100 }
  const returned = registry.definition('generate_image', 1)
  returned.parameters.properties!.extra = { type: 'string', maxLength: 100 }
  registry.listModelTools()[0].parameters.additionalProperties = true
  assert.throws(() => registry.validate('generate_image', 1, { injected: 'x' }), code('INVALID_ARGUMENTS'))
  assert.throws(() => registry.validate('generate_image', 1, { extra: 'x' }), code('INVALID_ARGUMENTS'))
  assert.equal(registry.definition('generate_image', 1).parameters.additionalProperties, false)
  assert.equal('credential' in createReadonlyToolRegistry({ mediaTools: [Object.assign(media(), { credential: 'hidden' })], allowlist: ['generate_image@v1'] }).listDefinitions()[0], false)
})

test('schema subset rejects unsupported keywords, unsafe or unbounded schemas at installation', () => {
  for (const schema of [
    { ...empty, additionalProperties: true }, { ...empty, $ref: '#/anything' }, { ...empty, oneOf: [] }, { ...empty, default: {} },
    { ...empty, required: ['missing'] }, { ...empty, required: ['a', 'a'], properties: { a: { type: 'boolean' } } },
    { type: 'string' }, { type: 'string', maxLength: 5, format: 'email' }, { type: 'string', maxLength: 5, pattern: '.*' },
    { type: 'array', items: { type: 'boolean' } }, { type: 'array', items: { type: 'boolean' }, minItems: 2, maxItems: 1 },
    { type: 'integer', minimum: 0.5 }, { type: 'number', maximum: Infinity }, { type: 'string', maxLength: 2, enum: ['long'] },
    { type: 'string', maxLength: 10, enum: [1] }, { type: 'boolean', enum: [] }, { type: ['string', 'null'] },
    JSON.parse('{"type":"object","properties":{"__proto__":{"type":"boolean"}},"required":[],"additionalProperties":false}'),
  ]) assert.throws(() => validateToolSchema(schema), code('INVALID_SCHEMA'))
  const schemaAccessor = Object.defineProperty({}, 'type', { enumerable: true, get() { throw new Error('Must not read schema accessor') } })
  assert.throws(() => validateToolSchema(schemaAccessor), code('INVALID_SCHEMA'))
  const cyclic: Record<string, unknown> = { ...empty }; cyclic.properties = { cyclic }
  assert.throws(() => validateToolSchema(cyclic), code('INVALID_SCHEMA'))
  let nested: ToolSchema = { type: 'boolean' }
  for (let i = 0; i < 14; i++) nested = { type: 'array', maxItems: 1, items: nested }
  assert.throws(() => validateToolSchema(nested), code('INVALID_SCHEMA'))
})

test('arguments enforce UUID, finite numbers, depth, closed nested objects and array boundaries without coercion', () => {
  const registry = createReadonlyToolRegistry()
  for (const input of [null, [], { assetId: 'x' }, { assetId: ownerId, ownerId }, { assetId: ownerId, constructor: 'x' },
    Object.assign(Object.create({ inherited: true }), { assetId: ownerId }), JSON.parse(`{"assetId":"${ownerId}","__proto__":{}}`), { assetId: `${ownerId}\u0000` }]) {
    assert.throws(() => registry.validate('get_asset', 1, input), code('INVALID_ARGUMENTS'))
  }
  for (const limit of [0, 51, 1.5, NaN, Infinity, -Infinity, '1', null]) assert.throws(() => registry.validate('search_assets', 1, { limit }), code('INVALID_ARGUMENTS'))
  for (const limit of [1, 50]) assert.equal(registry.validate('search_assets', 1, { limit }).arguments.limit, limit)
  assert.throws(() => registry.validate('search_assets', 1, { query: 'x'.repeat(101) }), code('INVALID_ARGUMENTS'))
  assert.throws(() => registry.validate('get_canvas', 1, { nodeIds: Array(51).fill(ownerId) }), code('INVALID_ARGUMENTS'))
  assert.throws(() => registry.validate('get_canvas', 1, { nodeIds: [] }), code('INVALID_ARGUMENTS'))
  assert.throws(() => registry.validate('get_canvas', 1, { nodeIds: new Array(1) }), code('INVALID_ARGUMENTS'))
  let calls = 0
  const accessor = Object.defineProperty({}, 'assetId', { enumerable: true, get() { calls++; return ownerId } })
  assert.throws(() => registry.validate('get_asset', 1, accessor), code('INVALID_ARGUMENTS'))
  assert.equal(calls, 0)
  assert.throws(() => registry.validate('search_assets', 1, { query: '\ud800' }), code('INVALID_ARGUMENTS'))
  assert.throws(() => registry.validate('search_assets', 1, { query: '\udc00' }), code('INVALID_ARGUMENTS'))
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  assert.throws(() => registry.validate('get_asset', 1, cyclic), code('INVALID_ARGUMENTS'))
  const nested = { a: {} }; let cursor: Record<string, unknown> = nested.a
  for (let i = 0; i < 14; i++) { const child = {}; cursor.child = child; cursor = child }
  assert.throws(() => registry.validate('get_asset', 1, nested), code('INVALID_ARGUMENTS'))
  const hidden = Object.defineProperty({ assetId: ownerId }, 'invisible', { enumerable: false, value: 'x' })
  assert.throws(() => registry.validate('get_asset', 1, hidden), code('INVALID_ARGUMENTS'))
  const symbol = { assetId: ownerId, [Symbol('extra')]: 'x' }
  assert.throws(() => registry.validate('get_asset', 1, symbol), code('INVALID_ARGUMENTS'))
  const schema: ToolSchema = { ...empty, properties: { array: { type: 'array', maxItems: 2, items: { type: 'number', minimum: 0, maximum: 1 } } } }
  assert.throws(() => validateToolArguments(schema, { array: [2] }), code('INVALID_ARGUMENTS'))
  assert.throws(() => validateToolArguments(schema, { array: [NaN] }), code('INVALID_ARGUMENTS'))
  assert.throws(() => validateToolArguments(schema, { array: [0, 0, 0] }), code('INVALID_ARGUMENTS'))
  validateToolArguments(schema, { array: [0, 1] })
  const hugeSchema: ToolSchema = { ...empty, properties: { array: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 16000 } } } }
  assert.throws(() => validateToolArguments(hugeSchema, { array: Array(10).fill('中'.repeat(3000)) }), code('INVALID_ARGUMENTS'))
})

test('dispatch redacts read-only handler errors, rejects oversized UTF8 results, validates owner and honors pre-aborted signal', async () => {
  const installed = readonlyTools()[0]
  const create = () => new ToolRegistry({ tools: [installed], allowlist: ['list_models@v1'] })
  installed.execute = async () => { throw new Error('postgres://secret:password@private/sql') }
  let registry = create()
  const call = registry.validate('list_models', 1, {})
  assert.deepEqual(await registry.dispatch(context, call), { kind: 'failed', error: { code: 'TOOL_FAILED', message: 'Tool execution failed', retryable: false } })
  installed.execute = async () => ({ kind: 'completed', result: { text: '中'.repeat(12000) } })
  registry = create()
  assert.ok('中'.repeat(12000).length < MAX_TOOL_OUTPUT_BYTES)
  await assert.rejects(registry.dispatch(context, call), code('RESULT_TOO_LARGE'))
  await assert.rejects(registry.dispatch({ ...context, ownerId: 'invalid' }, call), code('INVALID_ARGUMENTS'))
  let executed = false
  installed.execute = async () => { executed = true; return { kind: 'completed', result: {} } }
  registry = create()
  const controller = new AbortController(); controller.abort()
  assert.equal((await registry.dispatch({ ...context, signal: controller.signal }, call)).kind, 'failed')
  assert.equal(executed, false)
})

function sharedContext(sql: AgentSqlClient = { async query() { throw new Error('Unexpected query') } }): AgentToolContext {
  return { scope: { ownerId, sessionId: ownerId, turnId: ownerId },
    turn: { id: ownerId, sessionId: ownerId, status: 'running', engineVersion: 'test', revision: '1', inputRevision: '1',
      cancelRequestedAt: null, terminalAt: null, deadlineAt: '2026-11-18T00:00:00.000Z', error: null },
    round: { roundId: ownerId, position: 0, inputRevision: '1' }, toolCallId: ownerId, sql,
    budget: { async reserve() { throw new Error('Unexpected reservation') } }, signal: new AbortController().signal }
}
function sharedMedia(): AgentTool {
  return { name: 'generate_image', schemaVersion: 1, description: 'Fenced media', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    permissions: ['media:submit'], execution: 'media_async', approval: 'required',
    budget: { maxMediaJobs: 1, maxMediaOutputs: 4, maxEstimatedCost: { currency: 'USD', amount: '0.5', pricingReference: 'test' } },
    async execute() { return { kind: 'pending', jobIds: [ownerId] } } }
}

test('createAgentToolRegistry conforms to shared ports and exposes versioned model helpers', () => {
  const registry = createAgentToolRegistry({ tools: createReadonlyAgentTools(), allowlist: ['get_canvas@v1'] })
  const port: AgentToolRegistry = registry
  assert.deepEqual(port.list().map(tool => tool.name), ['get_canvas'])
  assert.equal(port.get('get_asset', 1), null)
  assert.equal(port.get('get_canvas', 2), null)
  assert.equal(port.get('get_canvas__v1', 1), null)
  assert.deepEqual(port.get('get_canvas', 1)?.parameters.required, ['canvasId'])
  assert.deepEqual(registry.listModelTools().map(tool => tool.name), ['get_canvas__v1'])
  assert.deepEqual(registry.validateModelCall('get_canvas__v1', { canvasId: ownerId }), { toolName: 'get_canvas', schemaVersion: 1, arguments: { canvasId: ownerId } })
  assert.throws(() => registry.validateModelCall('get_canvas__v1', {}), code('INVALID_ARGUMENTS'))
  assert.throws(() => registry.validate('get_asset', 1, { assetId: ownerId }), code('TOOL_NOT_ALLOWED'))
})

test('shared AgentTool execute cannot bypass installed schema or version allowlist', async () => {
  let executions = 0
  const incoming = sharedMedia()
  const source: AgentTool = { ...incoming, async execute() { executions++; return { kind: 'pending', jobIds: [ownerId] } } }
  const registry = createAgentToolRegistry({ tools: [source], allowlist: ['generate_image@v1'] })
  const tool = registry.get('generate_image', 1)!
  source.parameters.additionalProperties = true
  await assert.rejects(tool.execute(sharedContext(), { arbitrary: 'extra' }), code('INVALID_ARGUMENTS'))
  await assert.rejects(registry.list()[0].execute(sharedContext(), { ownerId }), code('INVALID_ARGUMENTS'))
  await assert.rejects(tool.execute({ ...sharedContext(), scope: { ownerId: 'invalid', sessionId: ownerId, turnId: ownerId } }, {}), code('INVALID_ARGUMENTS'))
  assert.equal(executions, 0)
  assert.deepEqual(await tool.execute(sharedContext(), {}), { kind: 'pending', jobIds: [ownerId] })
  assert.equal(executions, 1)
  const denied = createAgentToolRegistry({ tools: [sharedMedia()], allowlist: [] })
  assert.deepEqual(denied.list(), [])
  assert.equal(denied.get('generate_image', 1), null)
  await assert.rejects(denied.dispatch(sharedContext(), { toolName: 'generate_image', schemaVersion: 1, arguments: {} }), code('TOOL_NOT_ALLOWED'))
  assert.throws(() => createAgentToolRegistry({ tools: [sharedMedia()], allowlist: ['generate_image@v2'] }), code('UNKNOWN_TOOL'))
})

test('shared media retains required approval, frozen budget and exact original fenced context', async () => {
  const incoming = sharedMedia()
  const original = Object.assign(sharedContext(), { fencingToken: '42', expectedInputRevision: '7' })
  const observed: AgentToolContext[] = []
  const source: AgentTool = { ...incoming, async execute(context, args) {
    assert.equal(this, source)
    assert.deepEqual(args, {})
    observed.push(context)
    return { kind: 'pending', jobIds: [ownerId] }
  } }
  const registry = createAgentToolRegistry({ tools: [source], allowlist: ['generate_image@v1'] })
  const tool = registry.get('generate_image', 1)!
  assert.equal(tool.approval, 'required')
  assert.deepEqual(tool.budget, incoming.budget)
  assert.equal(Object.isFrozen(tool.budget), true)
  assert.equal(Object.isFrozen(tool.budget.maxEstimatedCost), true)
  await tool.execute(original, {})
  assert.equal(observed[0], original)
  assert.equal(observed[0].sql, original.sql)
  assert.equal(observed[0].budget, original.budget)
  assert.throws(() => createAgentToolRegistry({ tools: [{ ...incoming, approval: 'never' }], allowlist: ['generate_image@v1'] }), code('INVALID_REGISTRATION'))
})

test('media failure after an effect propagates for the fenced transaction owner to roll back', async () => {
  const failure = new Error('effect failed')
  const effects: string[] = []
  const sql: AgentSqlClient = { async query(text) { effects.push(text); return { rows: [], rowCount: 1 } } }
  const source: AgentTool = { ...sharedMedia(), async execute(context) {
    await context.sql.query('SELECT fenced_effect_fixture')
    throw failure
  } }
  const registry = createAgentToolRegistry({ tools: [source], allowlist: ['generate_image@v1'] })
  await assert.rejects(registry.get('generate_image', 1)!.execute(sharedContext(sql), {}), error => error === failure)
  assert.deepEqual(effects, ['SELECT fenced_effect_fixture'])
  const lowLevel = media()
  lowLevel.execute = async () => { throw failure }
  await assert.rejects(createReadonlyToolRegistry({ mediaTools: [lowLevel], allowlist: ['generate_image@v1'] }).dispatch(context,
    { toolName: 'generate_image', schemaVersion: 1, arguments: {} }), error => error === failure)
})

test('shared registry rejects schema accessors before cloning without executing getters', () => {
  const source = sharedMedia()
  let reads = 0
  Object.defineProperty(source.parameters, 'type', { enumerable: true, get() { reads++; return 'object' } })
  assert.throws(() => createAgentToolRegistry({ tools: [source], allowlist: ['generate_image@v1'] }), code('INVALID_SCHEMA'))
  assert.equal(reads, 0)
})

test('schema required arrays reject holes patched with non-index numeric properties', () => {
  const required = new Array<string>(1)
  Object.defineProperty(required, '4294967295', { enumerable: true, value: 'assetId' })
  const schema: ToolSchema = { ...empty, properties: { assetId: { type: 'string', format: 'uuid', maxLength: 36 } }, required }
  assert.throws(() => validateToolSchema(schema), code('INVALID_SCHEMA'))
  assert.throws(() => validateToolArguments(schema, {}), code('INVALID_SCHEMA'))
  const source: AgentTool = { ...sharedMedia(), parameters: { type: 'object', properties: { assetId: { type: 'string', format: 'uuid', maxLength: 36 } }, required, additionalProperties: false } }
  assert.throws(() => createAgentToolRegistry({ tools: [source], allowlist: ['generate_image@v1'] }), code('INVALID_SCHEMA'))
  const dense = ['assetId']
  Object.defineProperty(dense, '4294967295', { enumerable: true, value: 'assetId' })
  assert.throws(() => validateToolSchema({ ...schema, required: dense }), code('INVALID_SCHEMA'))
  assert.throws(() => validateToolArguments({ ...schema, required: ['assetId'] }, {}), code('INVALID_ARGUMENTS'))
})

test('schema string bounds count Unicode code points for valid supplementary characters', () => {
  const schema: ToolSchema = { ...empty, properties: { text: { type: 'string', minLength: 2, maxLength: 3 } }, required: ['text'] }
  validateToolArguments(schema, { text: '😀😀' })
  validateToolArguments(schema, { text: '😀ab' })
  assert.throws(() => validateToolArguments(schema, { text: '😀' }), code('INVALID_ARGUMENTS'))
  assert.throws(() => validateToolArguments(schema, { text: '😀😀😀😀' }), code('INVALID_ARGUMENTS'))
  validateToolSchema({ type: 'string', minLength: 2, maxLength: 2, enum: ['😀😀'] })
  assert.throws(() => validateToolSchema({ type: 'string', maxLength: 1, enum: ['😀😀'] }), code('INVALID_SCHEMA'))
  const registry = createReadonlyToolRegistry()
  for (const length of [60, 100]) assert.equal(registry.validate('search_assets', 1, { query: '😀'.repeat(length) }).arguments.query, '😀'.repeat(length))
  assert.throws(() => registry.validate('search_assets', 1, { query: '😀'.repeat(101) }), code('INVALID_ARGUMENTS'))
})
