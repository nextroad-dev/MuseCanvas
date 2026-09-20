import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LanguageProviderRegistry,
  NormalizedProviderError,
  type LanguageCompletionResult,
  type LanguageExecutionContext,
  type LanguageProviderManifest,
  type LanguageProviderPlugin,
  type LanguageRequest,
  type ProviderConfig,
} from './index'

function createMockLanguagePlugin(
  id: string,
  version: string,
  allowedHosts: string[] = ['api.example.com'],
): LanguageProviderPlugin {
  const manifest: LanguageProviderManifest = {
    kind: 'language',
    id,
    version,
    displayName: `Mock Language ${id}`,
    languageProtocols: ['openai_chat'],
    allowedHosts,
    credentialSchemas: ['legacy-api-key-v1'],
  }

  return {
    manifest,
    validateConfig(_config: ProviderConfig) {},
    async complete(
      _request: LanguageRequest,
      _config: ProviderConfig,
      _context: LanguageExecutionContext,
    ): Promise<LanguageCompletionResult> {
      return { text: 'ok' }
    },
  }
}

test('LanguageProviderRegistry: register/get/has with duplicate, invalid and missing rejections', () => {
  const registry = new LanguageProviderRegistry()
  const plugin = createMockLanguagePlugin('test-language', '1.0.0')

  registry.register(plugin)
  assert.equal(registry.has('test-language', '1.0.0'), true)
  assert.equal(registry.has('test-language', '2.0.0'), false)
  assert.equal(registry.get('test-language', '1.0.0'), plugin)

  assert.throws(() => registry.register(plugin), /DUPLICATE_PLUGIN_REGISTRATION/)
  assert.throws(
    () => registry.register(createMockLanguagePlugin('', '1.0.0')),
    /INVALID_PLUGIN_MANIFEST/,
  )

  assert.throws(
    () => registry.get('test-language', '9.9.9'),
    (err: unknown) => {
      assert.equal(err instanceof NormalizedProviderError, true)
      assert.equal((err as NormalizedProviderError).diagnostic.code, 'PROVIDER_NOT_CONFIGURED')
      return true
    },
  )

  assert.equal(registry.listManifests().length, 1)
})

test('language createExecutionContext does NOT widen the allowlist from config.baseUrl (security-relevant difference from the media registry)', async () => {
  const registry = new LanguageProviderRegistry()
  registry.register(createMockLanguagePlugin('mock-language', '1.0.0', ['api.openai.com']))

  let fetched = 0
  const fetchImpl = (async () => {
    fetched++
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch

  const context = registry.createExecutionContext('mock-language', '1.0.0', {
    config: { baseUrl: 'https://ssrf-target.internal.example' },
    fetchImpl,
  })

  // The media registry would append this host; the language registry must not.
  await assert.rejects(
    () => context.http.get('https://ssrf-target.internal.example/v1/models'),
    (err: unknown) => {
      assert.equal(err instanceof NormalizedProviderError, true)
      assert.equal((err as NormalizedProviderError).diagnostic.code, 'UNSAFE_URL')
      return true
    },
  )
  assert.equal(fetched, 0, 'baseUrl host must not be admitted before any fetch')

  // The manifest allowlist still applies.
  const ok = await context.http.get('https://api.openai.com/v1/models')
  assert.equal(ok.ok, true)
})

test('language createExecutionContext widens only via explicit additionalAllowedHosts', async () => {
  const registry = new LanguageProviderRegistry()
  registry.register(createMockLanguagePlugin('mock-language', '1.0.0', ['api.openai.com']))

  const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch
  const context = registry.createExecutionContext('mock-language', '1.0.0', {
    config: { baseUrl: 'https://custom.llm.example' },
    additionalAllowedHosts: ['custom.llm.example'],
    fetchImpl,
  })

  const res = await context.http.get('https://custom.llm.example/v1/models')
  assert.equal(res.ok, true)
})

test('language execution context carries http but never a bounded readOutput reader', () => {
  const registry = new LanguageProviderRegistry()
  registry.register(createMockLanguagePlugin('mock-language', '1.0.0'))
  const context = registry.createExecutionContext('mock-language', '1.0.0')
  assert.equal('readOutput' in context, false)
  assert.equal(typeof context.http.get, 'function')
})
