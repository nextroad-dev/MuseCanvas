import test from 'node:test'
import assert from 'node:assert/strict'
// The built-in media plugins self-register into the process-global media registry that the
// facade wraps, which keeps the "registered as media must not dispatch" assertion honest.
import './plugins/index'
import {
  LanguageModelHttpError,
  callLanguageModel,
  globalPluginRegistry,
  type DecodedCredential,
  type LanguageCompletionResult,
  type LanguageExecutionContext,
  type LanguageProviderManifest,
  type LanguageProviderPlugin,
  type LanguageRequest,
  type ProviderConfig,
} from './index'

type PluginHandler = (
  request: LanguageRequest,
  config: ProviderConfig,
  context: LanguageExecutionContext,
) => Promise<LanguageCompletionResult>

type Spy = { calls: Array<{ request: LanguageRequest; config: ProviderConfig; context: LanguageExecutionContext }> }

function registerLanguagePlugin(id: string, handler: PluginHandler): Spy {
  const manifest: LanguageProviderManifest = {
    kind: 'language',
    id,
    version: '1.0.0',
    displayName: `Installed ${id}`,
    languageProtocols: ['openai_chat'],
    allowedHosts: ['api.plugin.example'],
    credentialSchemas: ['legacy-api-key-v1', 'json-v1'],
    models: [{ id: 'plugin-model' }],
  }
  const spy: Spy = { calls: [] }
  const plugin: LanguageProviderPlugin = {
    manifest,
    validateConfig(_config: ProviderConfig) {},
    async complete(request, config, context) {
      spy.calls.push({ request, config, context })
      return handler(request, config, context)
    },
  }
  globalPluginRegistry.registerLanguage(plugin)
  return spy
}

const okCompletion: LanguageCompletionResult = { text: 'from the plugin', providerReferenceId: 'ref-1', inputTokens: 3, outputTokens: 5 }

const builtInInput = {
  protocol: 'openai_chat' as const,
  vendorModelId: 'gpt-4o',
  baseUrl: 'https://api.openai.com',
  apiKey: 'sk-built-in',
  system: 'sys',
  user: 'usr',
  maxOutputTokens: 64,
  timeoutMs: 1000,
}

/** Network-free harness: the built-in path defers to globalThis.fetch at call time. */
async function withStubbedFetch<T>(run: () => Promise<T>): Promise<{ value: T; fetchCalls: number }> {
  const original = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    return new Response(JSON.stringify({ id: 'built-in', choices: [{ message: { content: 'from the built-in path' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  try {
    return { value: await run(), fetchCalls }
  } finally {
    globalThis.fetch = original
  }
}

const pluginCall = (pluginId: string, credential?: DecodedCredential) =>
  callLanguageModel({ ...builtInInput, pluginId, pluginVersion: '1.0.0', ...(credential ? { credential } : {}) })

test('an absent pluginId never enters the installed-plugin branch', async () => {
  const spy = registerLanguagePlugin('dispatch-needs-plugin-id', async () => okCompletion)
  // Either half of the identity is not enough to select the plugin path.
  for (const partial of [{ pluginVersion: '1.0.0' }, { pluginId: 'dispatch-needs-plugin-id' }]) {
    const { value, fetchCalls } = await withStubbedFetch(() => callLanguageModel({ ...builtInInput, ...partial }))
    assert.equal(fetchCalls, 1, 'the built-in protocol path must own the request')
    assert.equal(value.text, 'from the built-in path')
  }
  assert.deepEqual(spy.calls, [])
})

test('a key that is not a registered language plugin falls through to the built-in path', async () => {
  const spy = registerLanguagePlugin('dispatch-unknown-version', async () => okCompletion)
  // Unknown version -> kindOf() is undefined.
  const wrongVersion = await withStubbedFetch(() => callLanguageModel({ ...builtInInput, pluginId: 'dispatch-unknown-version', pluginVersion: '9.9.9' }))
  assert.equal(wrongVersion.value.text, 'from the built-in path')
  assert.equal(wrongVersion.fetchCalls, 1)
  // Registered under the same key as media -> kindOf() is 'media', so the language kernel is never consulted.
  const mediaKey = await withStubbedFetch(() => callLanguageModel({ ...builtInInput, pluginId: 'openai-image', pluginVersion: '1.0.0' }))
  assert.equal(mediaKey.value.text, 'from the built-in path')
  assert.equal(mediaKey.fetchCalls, 1)
  assert.deepEqual(spy.calls, [])
})

test('a registered language plugin is invoked and its text is returned', async () => {
  const credential: DecodedCredential = { schema: 'json-v1', apiKey: 'from-payload', extra: { region: 'cn' } }
  const spy = registerLanguagePlugin('dispatch-happy-path', async () => okCompletion)
  const { value, fetchCalls } = await withStubbedFetch(() => pluginCall('dispatch-happy-path', credential))
  assert.equal(fetchCalls, 0, 'the plugin branch must never reach global fetch')
  assert.equal(value.text, 'from the plugin')
  assert.equal(value.providerReferenceId, 'ref-1')
  assert.equal(value.inputTokens, 3)
  assert.equal(value.outputTokens, 5)

  assert.equal(spy.calls.length, 1)
  const [call] = spy.calls
  assert.equal(call.request.vendorModelId, 'gpt-4o')
  assert.equal(call.request.system, 'sys')
  assert.equal(call.request.user, 'usr')
  assert.equal(call.request.maxOutputTokens, 64)
  assert.equal(call.request.timeoutMs, 1000)
  assert.equal(call.config.baseUrl, 'https://api.openai.com')
  assert.equal(call.config.credential, credential)
  assert.equal(call.config.timeoutMs, 1000)
  assert.equal(call.context.pluginId, 'dispatch-happy-path')
  assert.equal(call.context.version, '1.0.0')
  assert.equal(typeof call.context.http.post, 'function')
  assert.equal('readOutput' in call.context, false)
})

test('the apiKey fallback keeps legacy credentials working for installed plugins', async () => {
  const spy = registerLanguagePlugin('dispatch-legacy-key', async () => okCompletion)
  await withStubbedFetch(() => pluginCall('dispatch-legacy-key'))
  assert.deepEqual(spy.calls[0].config.credential, { schema: 'legacy-api-key-v1', apiKey: 'sk-built-in' })
})

test('PROVIDER_TEMPORARY_ERROR surfaces as PROMPT_OPTIMIZATION_TEMPORARY_ERROR', async () => {
  registerLanguagePlugin('dispatch-temporary-throws', async () => {
    throw Object.assign(new Error('PROVIDER_TEMPORARY_ERROR'), { diagnostic: { code: 'PROVIDER_TEMPORARY_ERROR', detail: 'upstream 503' } })
  })
  await assert.rejects(
    withStubbedFetch(() => pluginCall('dispatch-temporary-throws')).then(result => result.value),
    (error: unknown) => {
      assert.ok(error instanceof LanguageModelHttpError)
      assert.equal((error as LanguageModelHttpError).message, 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR')
      assert.equal((error as LanguageModelHttpError).diagnostic.statusText, 'PROVIDER_TEMPORARY_ERROR')
      assert.equal((error as LanguageModelHttpError).diagnostic.endpoint, 'plugin:dispatch-temporary-throws@1.0.0')
      return true
    },
  )
})

test('timeouts, in-band result errors and uncoded throws map through the inverse table', async () => {
  registerLanguagePlugin('dispatch-timeout', async () => {
    throw new Error('PROVIDER_TIMEOUT')
  })
  registerLanguagePlugin('dispatch-in-band-reject', async () => ({
    text: '',
    error: {
      pluginId: 'dispatch-in-band-reject',
      version: '1.0.0',
      code: 'PROVIDER_REJECTED',
      detail: 'content policy',
      occurredAt: '2026-01-01T00:00:00.000Z',
    },
  }))
  registerLanguagePlugin('dispatch-empty-result', async () => ({ text: undefined as unknown as string }))
  registerLanguagePlugin('dispatch-garbage', async () => {
    throw new Error('something exploded without a code')
  })

  const codes: Record<string, string> = {}
  for (const id of ['dispatch-timeout', 'dispatch-in-band-reject', 'dispatch-empty-result', 'dispatch-garbage']) {
    await withStubbedFetch(() => pluginCall(id)).then(result => result.value).catch((error: unknown) => {
      assert.ok(error instanceof LanguageModelHttpError, `${id} must throw a coded LanguageModelHttpError`)
      codes[id] = (error as LanguageModelHttpError).message
    })
  }
  assert.deepEqual(codes, {
    'dispatch-timeout': 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR',
    'dispatch-in-band-reject': 'PROMPT_OPTIMIZATION_REJECTED',
    'dispatch-empty-result': 'PROMPT_OPTIMIZATION_REJECTED',
    'dispatch-garbage': 'PROMPT_OPTIMIZATION_REJECTED',
  })
})

test('the plugin branch keeps the allowlist pinned: a config.baseUrl host is never widened', async () => {
  registerLanguagePlugin('dispatch-ssrf-attempt', async (_request, config, context) => {
    await context.http.get(`${String(config.baseUrl)}/v1/models`)
    return okCompletion
  })
  await assert.rejects(
    withStubbedFetch(() => callLanguageModel({
      ...builtInInput,
      baseUrl: 'https://169.254.169.254',
      pluginId: 'dispatch-ssrf-attempt',
      pluginVersion: '1.0.0',
    })).then(result => result.value),
    (error: unknown) => {
      assert.ok(error instanceof LanguageModelHttpError)
      assert.equal((error as LanguageModelHttpError).message, 'PROMPT_OPTIMIZATION_REJECTED')
      assert.equal((error as LanguageModelHttpError).diagnostic.statusText, 'UNSAFE_URL')
      return true
    },
  )
})
