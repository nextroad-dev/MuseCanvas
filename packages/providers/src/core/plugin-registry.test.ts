import test from 'node:test'
import assert from 'node:assert/strict'
// Side effect: register the 6 built-in media plugins into globalProviderRegistry,
// which the global facade wraps.
import '../plugins/index'
import {
  PluginRegistry,
  MediaProviderRegistry,
  LanguageProviderRegistry,
  globalPluginRegistry,
  type ExecutionContext,
  type LanguageCompletionResult,
  type LanguageExecutionContext,
  type LanguageProviderManifest,
  type LanguageProviderPlugin,
  type LanguageRequest,
  type MediaProviderManifest,
  type MediaProviderPlugin,
  type MediaRequest,
  type OperationResult,
  type ProviderConfig,
} from './index'

function mockMedia(id: string, version: string): MediaProviderPlugin {
  const manifest: MediaProviderManifest = {
    kind: 'media',
    id,
    version,
    displayName: `Mock Media ${id}`,
    modalities: ['image'],
    allowedHosts: ['media.example.com'],
    credentialSchemas: ['legacy-api-key-v1'],
  }
  return {
    manifest,
    validateConfig(_config: ProviderConfig) {},
    validateRequest(_request: MediaRequest) {},
    async submit(
      _request: MediaRequest,
      _config: ProviderConfig,
      _context: ExecutionContext,
    ): Promise<OperationResult> {
      return { status: 'succeeded', outputs: [] }
    },
  }
}

function mockLanguage(id: string, version: string): LanguageProviderPlugin {
  const manifest: LanguageProviderManifest = {
    kind: 'language',
    id,
    version,
    displayName: `Mock Language ${id}`,
    languageProtocols: ['openai_chat'],
    allowedHosts: ['language.example.com'],
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
      return { text: 'hi' }
    },
  }
}

const BUILT_IN_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['openai-image', '1.0.0'],
  ['openai-image', '1.1.0'],
  ['seedream-image', '1.0.0'],
  ['seedream-image', '1.1.0'],
  ['seedance-video', '1.0.0'],
  ['veo-video', '1.0.0'],
]

test('PluginRegistry rejects cross-kind id@version key collisions in both directions', () => {
  const registry = new PluginRegistry(new MediaProviderRegistry(), new LanguageProviderRegistry())
  registry.registerMedia(mockMedia('shared', '1.0.0'))
  assert.throws(
    () => registry.registerLanguage(mockLanguage('shared', '1.0.0')),
    /DUPLICATE_PLUGIN_REGISTRATION/,
  )
  assert.equal(registry.kindOf('shared', '1.0.0'), 'media')

  const other = new PluginRegistry(new MediaProviderRegistry(), new LanguageProviderRegistry())
  other.registerLanguage(mockLanguage('shared', '2.0.0'))
  assert.throws(
    () => other.registerMedia(mockMedia('shared', '2.0.0')),
    /DUPLICATE_PLUGIN_REGISTRATION/,
  )
  assert.equal(other.kindOf('shared', '2.0.0'), 'language')

  // Empty id/version must still be rejected as an invalid manifest, not a collision.
  assert.throws(
    () => registry.registerMedia(mockMedia('', '3.0.0')),
    /INVALID_PLUGIN_MANIFEST/,
  )
})

test('all six built-in media keys remain resolvable through the global facade as media kind', () => {
  for (const [id, version] of BUILT_IN_KEYS) {
    assert.equal(globalPluginRegistry.has(id, version), true, `${id}@${version} must resolve`)
    assert.equal(globalPluginRegistry.kindOf(id, version), 'media', `${id}@${version} must be media kind`)
    assert.equal(globalPluginRegistry.getMedia(id, version).manifest.id, id)
  }

  const keys = new Set(globalPluginRegistry.listManifests().map(m => `${m.id}@${m.version}`))
  for (const [id, version] of BUILT_IN_KEYS) {
    assert.ok(keys.has(`${id}@${version}`), `listManifests() must include ${id}@${version}`)
  }
})

test('listManifests surfaces both media and language manifests with their kind', () => {
  const registry = new PluginRegistry(new MediaProviderRegistry(), new LanguageProviderRegistry())
  registry.registerMedia(mockMedia('img', '1.0.0'))
  registry.registerLanguage(mockLanguage('llm', '1.0.0'))

  const manifests = registry.listManifests()
  assert.equal(manifests.length, 2)
  assert.equal(manifests.some(m => m.kind === 'media'), true)
  assert.equal(manifests.some(m => m.kind === 'language'), true)
  assert.equal(registry.kindOf('img', '1.0.0'), 'media')
  assert.equal(registry.kindOf('llm', '1.0.0'), 'language')
})

test('kindOf and has return false/undefined for unknown keys', () => {
  const registry = new PluginRegistry(new MediaProviderRegistry(), new LanguageProviderRegistry())
  assert.equal(registry.has('nope', '1.0.0'), false)
  assert.equal(registry.kindOf('nope', '1.0.0'), undefined)
})
