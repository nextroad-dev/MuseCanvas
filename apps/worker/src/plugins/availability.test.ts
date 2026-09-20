import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatPluginKey,
  globalPluginRegistry,
  globalProviderRegistry,
  NormalizedProviderError,
} from '../../../../packages/providers/src/index'
import type { MediaProviderPlugin } from '../../../../packages/providers/src/index'
import {
  assertBuiltinMediaPluginsAvailable,
  builtinMediaKeys,
  createMediaExecutionContext,
  forgetPluginStatus,
  installedActiveCount,
  installedLanguagePluginBinding,
  isBuiltinMediaKey,
  isPluginAvailable,
  resetPluginAvailability,
  resolveLanguagePlugin,
  resolveMediaPlugin,
  setPluginStatus,
  statusOf,
} from './availability'

const TEST_MEDIA_ID = 'availability-test-media'
const TEST_VERSION = '1.0.0'
const TEST_LANGUAGE_ID = 'availability-test-language'

function stubMediaPlugin(id: string, version: string): MediaProviderPlugin {
  return {
    manifest: {
      kind: 'media',
      id,
      version,
      displayName: `Stub ${id}`,
      modalities: ['image'],
      allowedHosts: ['api.example.com'],
      credentialSchemas: ['legacy-api-key-v1'],
    },
    validateConfig() {},
    validateRequest() {},
    async submit() {
      return { status: 'succeeded', outputs: [] }
    },
  }
}

function capture(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

/**
 * The disabled path must fail with the exact error the registries already throw for an
 * unregistered key, which is what keeps every job call site free of new handling.
 */
function assertNotConfigured(error: unknown, detail?: RegExp): NormalizedProviderError {
  assert.ok(error instanceof NormalizedProviderError, `expected NormalizedProviderError, got ${String(error)}`)
  assert.equal(error.message, 'PROVIDER_NOT_CONFIGURED')
  assert.equal(error.diagnostic.code, 'PROVIDER_NOT_CONFIGURED')
  if (detail) assert.match(error.diagnostic.detail, detail)
  return error
}

test('built-in media keys always resolve active through the gate', () => {
  const expected = [
    'openai-image@1.0.0',
    'openai-image@1.1.0',
    'seedance-video@1.0.0',
    'seedream-image@1.0.0',
    'seedream-image@1.1.0',
    'veo-video@1.0.0',
  ]
  const registered: string[] = globalProviderRegistry.listManifests().map(m => formatPluginKey(m.id, m.version)).sort()
  // The gate's snapshot is the registry taken before any artifact loads.
  assert.deepEqual([...builtinMediaKeys()].sort(), registered)
  assert.equal(assertBuiltinMediaPluginsAvailable(), registered.length)
  for (const key of expected) assert.ok(registered.includes(key), `expected built-in ${key}`)
  for (const key of registered) {
    const [id, version] = key.split('@')
    assert.equal(isBuiltinMediaKey(id, version), true, `${key} is a built-in`)
    assert.equal(isPluginAvailable(id, version), true, `${key} is available with no catalog row`)
    assert.equal(resolveMediaPlugin(id, version).manifest.id, id)
    const context = createMediaExecutionContext(id, version, {})
    assert.equal(context.pluginId, id)
    assert.equal(context.version, version)
  }
  resetPluginAvailability()
})

test('the catalog can never disable or shadow a built-in media key', () => {
  setPluginStatus('openai-image', '1.1.0', 'failed')
  assert.equal(statusOf('openai-image', '1.1.0'), 'active')
  assert.equal(isPluginAvailable('openai-image', '1.1.0'), true)
  assert.equal(resolveMediaPlugin('openai-image', '1.1.0').manifest.version, '1.1.0')
  // Built-ins are not counted against the installed-plugin cap.
  assert.equal(installedActiveCount(), 0)
  resetPluginAvailability()
})

test('untracked, disabled and failed installed keys all fail closed', () => {
  const plugin = stubMediaPlugin(TEST_MEDIA_ID, TEST_VERSION)
  globalProviderRegistry.register(plugin)

  assert.equal(statusOf(TEST_MEDIA_ID, TEST_VERSION), 'untracked')
  assertNotConfigured(capture(() => resolveMediaPlugin(TEST_MEDIA_ID, TEST_VERSION)), /is not registered/)

  setPluginStatus(TEST_MEDIA_ID, TEST_VERSION, 'disabled')
  assert.equal(isPluginAvailable(TEST_MEDIA_ID, TEST_VERSION), false)
  assertNotConfigured(capture(() => resolveMediaPlugin(TEST_MEDIA_ID, TEST_VERSION)), /is disabled/)
  // A disabled plugin must not obtain an egress-capable context either.
  assertNotConfigured(capture(() => createMediaExecutionContext(TEST_MEDIA_ID, TEST_VERSION, {})), /is disabled/)

  setPluginStatus(TEST_MEDIA_ID, TEST_VERSION, 'failed')
  assertNotConfigured(capture(() => resolveMediaPlugin(TEST_MEDIA_ID, TEST_VERSION)), /failed to load/)

  setPluginStatus(TEST_MEDIA_ID, TEST_VERSION, 'active')
  assert.equal(installedActiveCount(), 1)
  assert.equal(resolveMediaPlugin(TEST_MEDIA_ID, TEST_VERSION), plugin)
  assert.equal(createMediaExecutionContext(TEST_MEDIA_ID, TEST_VERSION, {}).pluginId, TEST_MEDIA_ID)

  forgetPluginStatus(TEST_MEDIA_ID, TEST_VERSION)
  assert.equal(statusOf(TEST_MEDIA_ID, TEST_VERSION), 'untracked')
  resetPluginAvailability()
})

test('language gating keys off registry membership, not the plugin_id column', () => {
  globalPluginRegistry.registerLanguage({
    manifest: {
      kind: 'language',
      id: TEST_LANGUAGE_ID,
      version: TEST_VERSION,
      displayName: 'Stub Language',
      languageProtocols: ['openai_chat'],
      allowedHosts: ['api.example.com'],
      credentialSchemas: ['legacy-api-key-v1'],
    },
    validateConfig() {},
    async complete() {
      return { text: 'ok' }
    },
  })
  assert.equal(globalPluginRegistry.kindOf(TEST_LANGUAGE_ID, TEST_VERSION), 'language')
  assertNotConfigured(capture(() => resolveLanguagePlugin(TEST_LANGUAGE_ID, TEST_VERSION)))

  setPluginStatus(TEST_LANGUAGE_ID, TEST_VERSION, 'active')
  assert.equal(resolveLanguagePlugin(TEST_LANGUAGE_ID, TEST_VERSION).manifest.id, TEST_LANGUAGE_ID)
  assert.deepEqual(
    installedLanguagePluginBinding({
      pluginId: TEST_LANGUAGE_ID,
      pluginVersion: TEST_VERSION,
      apiKey: 'sk-test-credential',
      credentialSchema: 'legacy-api-key-v1',
    }),
    {
      pluginId: TEST_LANGUAGE_ID,
      pluginVersion: TEST_VERSION,
      credential: { schema: 'legacy-api-key-v1', apiKey: 'sk-test-credential' },
    },
  )

  setPluginStatus(TEST_LANGUAGE_ID, TEST_VERSION, 'disabled')
  assertNotConfigured(capture(() => installedLanguagePluginBinding({
    pluginId: TEST_LANGUAGE_ID,
    pluginVersion: TEST_VERSION,
    apiKey: 'sk-test-credential',
  })), /is disabled/)

  // migrate.ts backfills model_configs.plugin_id onto every row with ids registered
  // nowhere; those must keep the built-in protocol payload byte-identical.
  for (const orphan of ['openai-language', 'anthropic-language', 'seedream-language']) {
    assert.equal(globalPluginRegistry.kindOf(orphan, TEST_VERSION), undefined)
    assert.equal(installedLanguagePluginBinding({ pluginId: orphan, pluginVersion: TEST_VERSION, apiKey: 'k' }), undefined)
  }
  assert.equal(installedLanguagePluginBinding({ pluginId: TEST_MEDIA_ID, pluginVersion: TEST_VERSION, apiKey: 'k' }), undefined)
  assert.equal(installedLanguagePluginBinding({ pluginId: null, pluginVersion: null, apiKey: 'k' }), undefined)
  resetPluginAvailability()
})

test('a key claimed by one kernel is refused by the other', () => {
  assert.equal(formatPluginKey(TEST_MEDIA_ID, TEST_VERSION), `${TEST_MEDIA_ID}@${TEST_VERSION}`)
  assert.equal(globalProviderRegistry.has(TEST_MEDIA_ID, TEST_VERSION), true)
  assert.throws(
    () => globalPluginRegistry.registerLanguage(stubMediaPlugin(TEST_MEDIA_ID, TEST_VERSION) as never),
    /DUPLICATE_PLUGIN_REGISTRATION/,
  )
})
