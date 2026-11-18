import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentModelRequest, CreateAgentModel } from './ports'
import { LanguageModelChatError, type LanguageModelChatInput, type LanguageModelChatResult, type OpenedCredential } from '@musecanvas/providers'
import {
  AgentModelError,
  createAgentLanguageModelAdapter,
  createAgentModel,
  bindAgentModelFactory,
  parseAgentModelSnapshot,
  type AgentModelChatRequest,
  type AgentModelOpenCredential,
  type AgentModelQuery,
} from './model'

const modelId = '10000000-0000-4000-8000-000000000001'
const revisionId = '10000000-0000-4000-8000-000000000002'
const credentialId = '10000000-0000-4000-8000-000000000003'
const otherRevision = '10000000-0000-4000-8000-000000000004'
const scope = { ownerId: '20000000-0000-4000-8000-000000000001', sessionId: '20000000-0000-4000-8000-000000000002', turnId: '20000000-0000-4000-8000-000000000003' }
const snapshot = { modelConfigId: modelId, modelRevisionId: revisionId }
const config = { ...snapshot, instructions: 'must not be logged', modelRevision: 3,
  protocol: 'openai_chat', pluginId: 'openai-language', pluginVersion: '1.0.0', providerId: 'openai',
  vendorModelId: 'gpt-test', maxOutputTokens: 1000, temperature: 0.5, reasoningEffort: 'low' }
const result: LanguageModelChatResult = { text: 'ok', toolCalls: [], contentBlocks: [{ type: 'text', text: 'ok' }], usage: {}, referenceId: 'ref' }
const opened: OpenedCredential = {
  raw: 'fixture-key',
  decoded: { schema: 'legacy-api-key-v1', apiKey: 'fixture-key' },
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turn_deadline_at: new Date(Date.now() + 60_000),
    turn_config_snapshot: config,
    model_id: modelId,
    model_kind: 'language',
    model_enabled: true,
    model_deleted_at: null,
    latest_revision_id: revisionId,
    model_provider_credential_id: credentialId,
    language_protocol: 'openai_chat',
    plugin_source: 'builtin',
    model_plugin_id: 'openai-language',
    model_plugin_version: '1.0.0',
    model_provider_id: 'openai',
    model_vendor_model_id: 'gpt-test',
    model_base_url: 'https://api.openai.com/v1',
    max_output_tokens: 1000,
    temperature: '0.5',
    reasoning_effort: 'low',
    revision_id: revisionId,
    revision_model_id: modelId,
    revision: 3,
    revision_provider_id: 'openai',
    revision_plugin_id: 'openai-language',
    revision_plugin_version: '1.0.0',
    revision_vendor_model_id: 'gpt-test',
    revision_base_url: 'https://api.openai.com/v1',
    revision_credential_id: credentialId,
    revision_credential_schema_version: 1,
    normalized_config: {
      vendorModelId: 'gpt-test',
      baseUrl: 'https://api.openai.com/v1',
      languageProtocol: 'openai_chat',
      maxOutputTokens: 1000,
      temperature: 0.5,
      reasoningEffort: 'low',
    },
    credential_id: credentialId,
    credential_enabled: true,
    credential_deleted_at: null,
    credential_provider_id: 'openai',
    credential_schema_id: 'legacy-api-key-v1',
    credential_schema_version: 1,
    payload_encrypted: 'fixture-ciphertext',
    api_key_encrypted: null,
    encryption_key_id: null,
    ...overrides,
  }
}

function request(overrides: Partial<AgentModelChatRequest> = {}): AgentModelChatRequest {
  return {
    ...scope,
    turnConfigSnapshot: config,
    system: config.instructions,
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 200,
    control: { deadlineAt: Date.now() + 60_000 },
    ...overrides,
  }
}

function fixture(options: { rows?: readonly Record<string, unknown>[]; query?: AgentModelQuery; open?: AgentModelOpenCredential; chat?: (input: LanguageModelChatInput) => Promise<LanguageModelChatResult> } = {}) {
  const calls: unknown[][] = []
  const query: AgentModelQuery = options.query ?? (async (sql, parameters) => {
    calls.push([sql, parameters])
    return { rows: options.rows ?? [row()] }
  })
  const chatInputs: LanguageModelChatInput[] = []
  const chat = options.chat ?? (async (input: LanguageModelChatInput) => {
    chatInputs.push(input)
    return result
  })
  const openInputs: { row: unknown; plugin: unknown }[] = []
  const openCredential: AgentModelOpenCredential = options.open ?? ((fields, plugin) => {
    openInputs.push({ row: fields, plugin })
    return opened
  })
  return {
    calls,
    chatInputs,
    openInputs,
    adapter: createAgentLanguageModelAdapter({ query, chat, openCredential, now: () => Date.now() }),
  }
}

async function rejectsCode(promise: Promise<unknown>, code: AgentModelError['code']) {
  await assert.rejects(promise, (error: unknown) => error instanceof AgentModelError && error.code === code)
}

test('agent model: resolves pinned revision, live model and stored credential, then calls chat outside the query', async () => {
  const f = fixture()
  const response = await f.adapter.chat(request())
  assert.deepEqual(response, result)
  assert.equal(f.calls.length, 1)
  const [sql, parameters] = f.calls[0] as [string, unknown[]]
  assert.match(sql, /JOIN model_config_revisions r ON r\.id=\$2 AND r\.model_id=m\.id/)
  assert.match(sql, /m\.latest_revision_id=\$2/)
  assert.match(sql, /s.owner_id=\$3 AND s.id=\$4 AND t.id=\$5/)
  assert.deepEqual(parameters, [modelId, revisionId, scope.ownerId, scope.sessionId, scope.turnId])
  assert.equal(f.openInputs.length, 1)
  assert.deepEqual(f.openInputs[0], {
    row: { payload_encrypted: 'fixture-ciphertext', api_key_encrypted: null, encryption_key_id: null, schema_id: 'legacy-api-key-v1' },
    plugin: { pluginId: 'openai-language', pluginVersion: '1.0.0' },
  })
  const input = f.chatInputs[0]!
  assert.equal(input.protocol, 'openai_chat')
  assert.equal(input.vendorModelId, 'gpt-test')
  assert.equal(input.baseUrl, 'https://api.openai.com/v1')
  assert.equal(input.apiKey, 'fixture-key')
  assert.equal(input.pluginId, 'openai-language')
  assert.equal(input.maxOutputTokens, 200, 'budget cap narrows the model maximum')
  assert.equal(input.temperature, 0.5)
  assert.equal(input.reasoningEffort, 'low')
  assert.equal(input.signal?.aborted, false)
  assert.ok(input.timeoutMs > 0 && input.timeoutMs <= 60_000)
  assert.equal('credential' in input, false, 'the raw credential object never crosses into the provider request')
  assert.equal(f.calls.length, 1, 'no database query is issued during the model call')
})

test('agent model: pinned/live identity drift and unsafe bindings fail closed before any credential or provider use', async () => {
  const cases: [string, Record<string, unknown>, AgentModelError['code']][] = [
    ['revision not latest', { latest_revision_id: otherRevision }, 'AGENT_MODEL_UNAVAILABLE'],
    ['model disabled', { model_enabled: false }, 'AGENT_MODEL_UNAVAILABLE'],
    ['model deleted', { model_deleted_at: new Date() }, 'AGENT_MODEL_UNAVAILABLE'],
    ['wrong model kind', { model_kind: 'image' }, 'AGENT_MODEL_UNAVAILABLE'],
    ['installed plugin source', { plugin_source: 'installed' }, 'AGENT_MODEL_UNAVAILABLE'],
    ['protocol plugin mismatch', { revision_plugin_id: 'anthropic-language', revision_plugin_version: '1.0.0' }, 'AGENT_MODEL_UNAVAILABLE'],
    ['vendor model drift', { model_vendor_model_id: 'gpt-other' }, 'AGENT_MODEL_UNAVAILABLE'],
    ['base URL drift', { model_base_url: 'https://proxy.example.com' }, 'AGENT_MODEL_UNAVAILABLE'],
    ['snapshot parameter drift', { normalized_config: { vendorModelId: 'gpt-test', maxOutputTokens: 999 } }, 'AGENT_MODEL_UNAVAILABLE'],
    ['unsupported protocol', { language_protocol: 'openai_responses' }, 'AGENT_MODEL_UNAVAILABLE'],
    ['credential disabled', { credential_enabled: false }, 'AGENT_MODEL_UNAVAILABLE'],
    ['credential deleted', { credential_deleted_at: new Date() }, 'AGENT_MODEL_CREDENTIAL_UNAVAILABLE'],
    ['credential provider mismatch', { credential_provider_id: 'anthropic' }, 'AGENT_MODEL_CREDENTIAL_UNAVAILABLE'],
    ['credential schema mismatch', { credential_schema_id: 'json-v1' }, 'AGENT_MODEL_CREDENTIAL_UNAVAILABLE'],
    ['model credential re-pointed', { model_provider_credential_id: otherRevision }, 'AGENT_MODEL_UNAVAILABLE'],
  ]
  for (const [name, overrides, code] of cases) {
    const f = fixture({ rows: [row(overrides)] })
    await rejectsCode(f.adapter.chat(request()), code)
    assert.equal(f.chatInputs.length, 0, name)
    assert.equal(f.openInputs.length, 0, name)
  }
})

test('agent model: higher prompt temperature cannot exceed the pinned range and anthropic effort stays valid', async () => {
  const f = fixture({
    rows: [row({ temperature: '3', normalized_config: { vendorModelId: 'gpt-test', baseUrl: 'https://api.openai.com/v1', languageProtocol: 'openai_chat', maxOutputTokens: 1000, temperature: 3 } })],
  })
  await rejectsCode(f.adapter.chat(request()), 'AGENT_MODEL_UNAVAILABLE')
  const a = fixture({
    rows: [row({
      language_protocol: 'anthropic_messages', model_plugin_id: 'anthropic-language', revision_plugin_id: 'anthropic-language',
      model_provider_id: 'anthropic', revision_provider_id: 'anthropic', credential_provider_id: 'anthropic',
      model_vendor_model_id: 'claude-test', revision_vendor_model_id: 'claude-test', model_base_url: 'https://api.anthropic.com',
      revision_base_url: 'https://api.anthropic.com', reasoning_effort: 'high',
      normalized_config: { vendorModelId: 'claude-test', baseUrl: 'https://api.anthropic.com', languageProtocol: 'anthropic_messages', maxOutputTokens: 1000, temperature: 0.5, reasoningEffort: 'high' },
    })],
  })
  await rejectsCode(a.adapter.chat(request()), 'AGENT_MODEL_UNAVAILABLE')
})

test('agent model: credential opening failures map to a stable code without ciphertext or raw exceptions', async () => {
  const f = fixture({
    open: () => { throw new Error('DECRYPTION_FAILED fixture-ciphertext sk-secret') },
  })
  await assert.rejects(f.adapter.chat(request()), (error: unknown) => {
    assert.ok(error instanceof AgentModelError)
    assert.equal(error.code, 'AGENT_MODEL_CREDENTIAL_UNAVAILABLE')
    assert.equal(error.message, 'AGENT_MODEL_CREDENTIAL_UNAVAILABLE')
    assert.doesNotMatch(String(error), /fixture-ciphertext|sk-secret|DECRYPTION_FAILED/)
    return true
  })
  assert.equal(f.chatInputs.length, 0)
})

test('agent model: database failures cannot leak SQL or key material through the error', async () => {
  const f = fixture({
    query: async () => { throw new Error('SELECT payload_encrypted FROM model_configs sk-live-secret') },
  })
  await assert.rejects(f.adapter.chat(request()), (error: unknown) => {
    assert.ok(error instanceof AgentModelError)
    assert.equal(error.code, 'AGENT_MODEL_STORE_UNAVAILABLE')
    assert.doesNotMatch(String(error), /SELECT|payload_encrypted|sk-live-secret/)
    return true
  })
  assert.equal(f.chatInputs.length, 0)
})

test('agent model: canceled, lease-lost and elapsed deadlines are distinct and never reach chat', async () => {
  let queryCalls = 0
  const f = fixture({
    query: async () => { queryCalls++; return { rows: [row()] } },
  })
  const canceled = new AbortController()
  canceled.abort()
  await rejectsCode(f.adapter.chat(request({ control: { deadlineAt: Date.now() + 60_000, cancel: canceled.signal } })), 'AGENT_MODEL_CANCELED')
  const lease = new AbortController()
  lease.abort()
  await rejectsCode(f.adapter.chat(request({ control: { deadlineAt: Date.now() + 60_000, lease: lease.signal } })), 'AGENT_MODEL_LEASE_LOST')
  await rejectsCode(f.adapter.chat(request({ control: { deadlineAt: Date.now() - 1 } })), 'AGENT_MODEL_DEADLINE_EXCEEDED')
  assert.equal(queryCalls, 0)
  assert.equal(f.chatInputs.length, 0)
})

test('agent model: aborting the combined control signal aborts an in-flight provider call', async () => {
  let chatCalls = 0
  let started!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const f = fixture({
    chat: async input => new Promise<LanguageModelChatResult>((_resolve, reject) => {
      chatCalls++
      const abort = () => reject(new LanguageModelChatError('LANGUAGE_MODEL_CANCELED'))
      input.signal!.addEventListener('abort', abort, { once: true })
      started()
    }),
  })
  const cancel = new AbortController()
  const pending = f.adapter.chat(request({ control: { deadlineAt: Date.now() + 60_000, cancel: cancel.signal } }))
  await startedPromise
  cancel.abort()
  await rejectsCode(pending, 'AGENT_MODEL_CANCELED')
  assert.equal(chatCalls, 1)
})

test('agent model: provider failures are mapped to separate safe codes', async () => {
  const cases: [ConstructorParameters<typeof LanguageModelChatError>[0], AgentModelError['code']][] = [
    ['LANGUAGE_MODEL_TIMEOUT', 'AGENT_MODEL_TIMEOUT'],
    ['LANGUAGE_MODEL_RESPONSE_INVALID', 'AGENT_MODEL_RESPONSE_INVALID'],
    ['LANGUAGE_MODEL_RESPONSE_TOO_LARGE', 'AGENT_MODEL_RESPONSE_TOO_LARGE'],
    ['LANGUAGE_MODEL_REJECTED', 'AGENT_MODEL_REJECTED'],
    ['LANGUAGE_MODEL_TEMPORARY_ERROR', 'AGENT_MODEL_TEMPORARY'],
    ['LANGUAGE_MODEL_UNSUPPORTED', 'AGENT_MODEL_UNSUPPORTED'],
  ]
  for (const [providerCode, expected] of cases) {
    const f = fixture({ chat: async () => { throw new LanguageModelChatError(providerCode, 500) } })
    await assert.rejects(f.adapter.chat(request()), (error: unknown) => {
      assert.ok(error instanceof AgentModelError)
      assert.equal(error.code, expected)
      assert.equal(error.message, expected)
      return true
    })
  }
  const generic = fixture({ chat: async () => { throw new Error('provider body fixture-key') } })
  await rejectsCode(generic.adapter.chat(request()), 'AGENT_MODEL_TEMPORARY')
})

test('agent model: snapshot parsing reads only the pinned ids and rejects malformed input', () => {
  assert.deepEqual(parseAgentModelSnapshot({ ...snapshot, baseUrl: 'https://evil.example.com', apiKey: 'secret' }), snapshot)
  for (const value of [null, {}, { modelConfigId: modelId }, { modelConfigId: 'not-a-uuid', modelRevisionId: revisionId }, { modelConfigId: modelId, modelRevisionId: 'not-a-uuid' }]) {
    assert.throws(() => parseAgentModelSnapshot(value), (error: unknown) => error instanceof AgentModelError && error.code === 'AGENT_MODEL_CONFIG_INVALID')
  }
})

test('agent model: owner, session and Turn scope are bound in the single lookup', async () => {
  for (const key of ['ownerId', 'sessionId', 'turnId'] as const) {
    let opens = 0
    let chats = 0
    const f = fixture({
      query: async (_sql, parameters) => ({ rows: parameters.slice(2).every((value, index) => value === [scope.ownerId, scope.sessionId, scope.turnId][index]) ? [row()] : [] }),
      open: () => { opens++; return opened },
      chat: async () => { chats++; return result },
    })
    await rejectsCode(f.adapter.chat(request({ [key]: otherRevision })), 'AGENT_MODEL_UNAVAILABLE')
    assert.equal(opens, 0)
    assert.equal(chats, 0)
  }
})

test('agent model: admission parameters cannot be replaced by current model values or request overrides', async () => {
  for (const changes of [
    { maxOutputTokens: 999 }, { temperature: null }, { reasoningEffort: 'high' },
    { providerId: 'anthropic' }, { protocol: 'openai_responses' }, { modelRevisionId: otherRevision },
  ]) {
    const f = fixture({ rows: [row({ turn_config_snapshot: { ...config, ...changes } })] })
    await rejectsCode(f.adapter.chat(request()), 'AGENT_MODEL_UNAVAILABLE')
    assert.equal(f.openInputs.length, 0)
  }
  const f = fixture()
  await rejectsCode(f.adapter.chat(request({ turnConfigSnapshot: { ...config, maxOutputTokens: 999 } })), 'AGENT_MODEL_UNAVAILABLE')
  assert.equal(f.chatInputs.length, 0)
})

test('agent model: decoded schema and credential endpoint cannot bypass the pinned binding', async () => {
  for (const decoded of [
    { schema: 'json-v1', apiKey: 'fixture-key' },
    { schema: 'legacy-api-key-v1', apiKey: 'fixture-key', baseUrl: 'https://different.example/v1' },
  ]) {
    const f = fixture({ open: () => ({ raw: 'fixture-key', decoded }) })
    await rejectsCode(f.adapter.chat(request()), 'AGENT_MODEL_CREDENTIAL_UNAVAILABLE')
    assert.equal(f.chatInputs.length, 0)
  }
  const f = fixture({ rows: [row({ credential_base_url: 'https://different.example/v1' })] })
  await rejectsCode(f.adapter.chat(request()), 'AGENT_MODEL_CREDENTIAL_UNAVAILABLE')
  assert.equal(f.openInputs.length, 0)
})

test('agent model: persisted deadline narrows timeout and late successful responses are discarded', async () => {
  let time = Date.now()
  const lease = new AbortController()
  const adapter = createAgentLanguageModelAdapter({
    now: () => time,
    query: async () => ({ rows: [row({ turn_deadline_at: new Date(time + 1000) })] }),
    openCredential: () => opened,
    chat: async input => {
      assert.equal(input.timeoutMs, 1000)
      assert.ok(input.signal)
      time += 1000
      return result
    },
  })
  await rejectsCode(adapter.chat(request()), 'AGENT_MODEL_DEADLINE_EXCEEDED')
  const f = fixture({ chat: async () => { lease.abort(); return result } })
  await rejectsCode(f.adapter.chat(request({ control: { deadlineAt: time + 60_000, lease: lease.signal } })), 'AGENT_MODEL_LEASE_LOST')
})

test('agent model: factory construction does not query, open credentials or call chat', () => {
  const f = fixture()
  assert.equal(f.calls.length, 0)
  assert.equal(f.openInputs.length, 0)
  assert.equal(f.chatInputs.length, 0)
})

test('agent model: Anthropic resolves through the same builtin pinned path', async () => {
  const anthropicConfig = { ...config, protocol: 'anthropic_messages', pluginId: 'anthropic-language',
    providerId: 'anthropic', vendorModelId: 'claude-test', reasoningEffort: null }
  const f = fixture({ rows: [row({
    turn_config_snapshot: anthropicConfig,
    language_protocol: 'anthropic_messages', model_plugin_id: 'anthropic-language', revision_plugin_id: 'anthropic-language',
    model_provider_id: 'anthropic', revision_provider_id: 'anthropic', credential_provider_id: 'anthropic',
    model_vendor_model_id: 'claude-test', revision_vendor_model_id: 'claude-test', model_base_url: 'https://api.anthropic.com',
    revision_base_url: 'https://api.anthropic.com', reasoning_effort: null,
    normalized_config: { vendorModelId: 'claude-test', baseUrl: 'https://api.anthropic.com', languageProtocol: 'anthropic_messages', maxOutputTokens: 1000, temperature: 0.5 },
  })] })
  assert.deepEqual(await f.adapter.chat(request({ turnConfigSnapshot: anthropicConfig })), result)
  assert.equal(f.chatInputs[0]!.protocol, 'anthropic_messages')
  assert.equal(f.chatInputs[0]!.reasoningEffort, null)
  assert.equal(f.chatInputs[0]!.apiKey, 'fixture-key')
})

test('agent model: frozen complete factory binds the Turn, converts the public revision and combines its signal', async () => {
  let loads = 0
  const inputs: LanguageModelChatInput[] = []
  const factory = createAgentModel({
    scope,
    control: { deadlineAt: Date.now() + 60_000 },
    query: async () => ({ rows: [row()] }),
    openCredential: () => opened,
    loadCredential: async () => { loads++; throw new Error('weak lookup must not be used') },
    chat: async input => { inputs.push(input); return result },
  })
  const controller = new AbortController()
  assert.deepEqual(await factory.complete({
    config: { ...config, protocol: 'openai_chat', reasoningEffort: 'low', modelRevision: '3', timeoutMs: 500 },
    instructions: config.instructions,
    messages: [{ role: 'user', content: 'hello' }], tools: [], signal: controller.signal,
  }), result)
  assert.equal(loads, 0)
  assert.ok(inputs[0]!.timeoutMs <= 500)
  controller.abort()
  await rejectsCode(factory.complete({
    config: { ...config, protocol: 'openai_chat', reasoningEffort: 'low', modelRevision: '3', timeoutMs: 500 },
    instructions: config.instructions, messages: [{ role: 'user', content: 'hello' }], tools: [], signal: controller.signal,
  }), 'AGENT_MODEL_CANCELED')
})

function portRequest(signal = new AbortController().signal): AgentModelRequest {
  return {
    config: { ...config, protocol: 'openai_chat', reasoningEffort: 'low', modelRevision: '3', timeoutMs: 500 },
    instructions: config.instructions, messages: [{ role: 'user', content: 'hello' }], tools: [], signal,
  }
}

test('agent model review P1: outer binder returns the exact frozen factory without using weak credential lookup', async () => {
  let queries = 0
  let calls = 0
  const factory: CreateAgentModel = bindAgentModelFactory({
    scope, control: { deadlineAt: Date.now() + 1000 },
    query: async () => { queries++; return { rows: [row()] } },
    openCredential: () => opened,
    chat: async () => { calls++; return result },
  })
  const port = factory({ loadCredential: async () => { throw new Error('weak loader must not run') } })
  assert.deepEqual(await port.complete(portRequest()), result)
  assert.equal(queries, 1)
  assert.equal(calls, 1)
})

test('agent model review P1: aborting only the bound request aborts the in-flight frozen port call', async () => {
  const boundRequest = new AbortController()
  const inputRequest = new AbortController()
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  let providerSignal: AbortSignal | undefined
  const factory: CreateAgentModel = bindAgentModelFactory({
    scope, control: { deadlineAt: Date.now() + 1000, request: boundRequest.signal },
    query: async () => ({ rows: [row()] }), openCredential: () => opened,
    chat: input => new Promise((_resolve, reject) => {
      providerSignal = input.signal
      input.signal!.addEventListener('abort', () => reject(new LanguageModelChatError('LANGUAGE_MODEL_CANCELED')), { once: true })
      start()
    }),
  })
  const pending = factory({ loadCredential: async () => ({}) }).complete(portRequest(inputRequest.signal))
  await started
  boundRequest.abort()
  await rejectsCode(pending, 'AGENT_MODEL_CANCELED')
  assert.equal(inputRequest.signal.aborted, false)
  assert.equal(providerSignal?.aborted, true)
})

test('agent model review P1: a never-resolving query wait expires at the deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  let querySignal: AbortSignal | undefined
  let opens = 0
  let chats = 0
  const adapter = createAgentLanguageModelAdapter({
    query: (_sql, _params, options) => {
      assert.equal(options?.timeoutMs, 100)
      querySignal = options?.signal
      return new Promise(() => {})
    },
    openCredential: () => { opens++; return opened },
    chat: async () => { chats++; return result },
  })
  const pending = adapter.chat(request({ control: { deadlineAt: Date.now() + 100 } }))
  const rejected = rejectsCode(pending, 'AGENT_MODEL_DEADLINE_EXCEEDED')
  t.mock.timers.tick(100)
  await rejected
  assert.equal(querySignal?.aborted, true)
  assert.equal(opens, 0)
  assert.equal(chats, 0)
})

for (const source of ['request', 'cancel', 'lease'] as const) {
  test(`agent model review P1: ${source} abort interrupts an unresolved query and ignores its late result`, async () => {
    const controller = new AbortController()
    let finish!: (value: { rows: Record<string, unknown>[] }) => void
    let opens = 0
    let chats = 0
    let querySignal: AbortSignal | undefined
    const adapter = createAgentLanguageModelAdapter({
      query: (_sql, _params, options) => {
        querySignal = options?.signal
        return new Promise(resolve => { finish = resolve })
      },
      openCredential: () => { opens++; return opened },
      chat: async () => { chats++; return result },
    })
    const pending = adapter.chat(request({ control: { deadlineAt: Date.now() + 1000, [source]: controller.signal } }))
    controller.abort()
    await rejectsCode(pending, source === 'lease' ? 'AGENT_MODEL_LEASE_LOST' : 'AGENT_MODEL_CANCELED')
    assert.equal(querySignal?.aborted, true)
    finish({ rows: [row()] })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(opens, 0)
    assert.equal(chats, 0)
  })
}

test('agent model review P1: a query rejection arriving after cancellation stays observed and safe', async () => {
  const controller = new AbortController()
  let rejectQuery!: (error: Error) => void
  const f = fixture({ query: () => new Promise((_resolve, reject) => { rejectQuery = reject }) })
  const pending = f.adapter.chat(request({ control: { deadlineAt: Date.now() + 1000, cancel: controller.signal } }))
  controller.abort()
  await rejectsCode(pending, 'AGENT_MODEL_CANCELED')
  rejectQuery(new Error('late SQL failure contains secret'))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.openInputs.length, 0)
  assert.equal(f.chatInputs.length, 0)
})

test('agent model review P1: actual system must match persisted instructions before opening credentials', async () => {
  const f = fixture()
  await rejectsCode(f.adapter.chat(request({ system: 'replacement instructions' })), 'AGENT_MODEL_UNAVAILABLE')
  assert.equal(f.calls.length, 1)
  assert.equal(f.openInputs.length, 0)
  assert.equal(f.chatInputs.length, 0)
})
