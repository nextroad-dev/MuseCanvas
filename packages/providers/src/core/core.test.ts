import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MediaProviderRegistry,
  formatPluginKey,
  parsePluginKey,
  decodeCredential,
  NormalizedProviderError,
  DefaultSafeHttpClient,
  readBoundedOutput,
  extractImageDimensions,
  type MediaProviderPlugin,
  type MediaProviderManifest,
  type ProviderConfig,
  type ExecutionContext,
  type MediaRequest,
  type OperationResult,
  type OutputDescriptor,
} from './index'

function createMockPlugin(id: string, version: string): MediaProviderPlugin {
  const manifest: MediaProviderManifest = {
    id,
    version,
    displayName: `Mock Plugin ${id}`,
    modalities: ['image'],
    allowedHosts: ['mock.openai.com'],
    credentialSchemas: ['legacy-api-key-v1'],
  }

  return {
    manifest,
    validateConfig(_config: ProviderConfig) {},
    validateRequest(_request: MediaRequest) {},
    async submit(_req: MediaRequest, _cfg: ProviderConfig, _ctx: ExecutionContext): Promise<OperationResult> {
      return { status: 'succeeded', outputs: [] }
    },
  }
}

test('MediaProviderRegistry: exact-version lookup and duplicate registration rejection', () => {
  const registry = new MediaProviderRegistry()
  const pluginV1 = createMockPlugin('test-image', '1.0.0')
  const pluginV2 = createMockPlugin('test-image', '2.0.0')

  registry.register(pluginV1)
  registry.register(pluginV2)

  assert.equal(registry.has('test-image', '1.0.0'), true)
  assert.equal(registry.has('test-image', '2.0.0'), true)
  assert.equal(registry.has('test-image', '3.0.0'), false)

  assert.equal(registry.get('test-image', '1.0.0'), pluginV1)
  assert.equal(registry.get('test-image', '2.0.0'), pluginV2)

  // Duplicate rejection
  assert.throws(
    () => registry.register(pluginV1),
    /DUPLICATE_PLUGIN_REGISTRATION/,
  )

  // Missing version lookup rejection
  assert.throws(
    () => registry.get('test-image', '3.0.0'),
    (err: unknown) => {
      assert.equal(err instanceof NormalizedProviderError, true)
      assert.equal((err as NormalizedProviderError).diagnostic.code, 'PROVIDER_NOT_CONFIGURED')
      return true
    },
  )

  assert.equal(registry.listManifests().length, 2)
})

test('formatPluginKey and parsePluginKey', () => {
  assert.equal(formatPluginKey('openai-image', '1.0.0'), 'openai-image@1.0.0')
  assert.deepEqual(parsePluginKey('openai-image@1.0.0'), { id: 'openai-image', version: '1.0.0' })
  assert.throws(() => parsePluginKey('invalid-key'), /INVALID_PLUGIN_KEY/)
})

test('decodeCredential handles legacy strings and JSON objects without env access', () => {
  // Legacy string
  const cred1 = decodeCredential('sk-test-secret-12345678')
  assert.equal(cred1.schema, 'legacy-api-key-v1')
  assert.equal(cred1.apiKey, 'sk-test-secret-12345678')

  // JSON string
  const cred2 = decodeCredential(JSON.stringify({ apiKey: 'key-abc', baseUrl: 'https://api.example.com', extraField: 42 }))
  assert.equal(cred2.schema, 'json-v1')
  assert.equal(cred2.apiKey, 'key-abc')
  assert.equal(cred2.baseUrl, 'https://api.example.com')
  assert.deepEqual(cred2.extra, { extraField: 42 })

  // Object
  const cred3 = decodeCredential({ apiKey: 'obj-key', schema: 'custom-v2' })
  assert.equal(cred3.schema, 'custom-v2')
  assert.equal(cred3.apiKey, 'obj-key')

  // Empty / null
  assert.throws(() => decodeCredential(''), (err: unknown) => {
    assert.equal(err instanceof NormalizedProviderError, true)
    assert.equal((err as NormalizedProviderError).diagnostic.code, 'INVALID_CREDENTIAL')
    return true
  })
})

test('DefaultSafeHttpClient enforces HTTPS and allowed hosts without global fetch leakage', async () => {
  let fetchedUrl = ''
  let fetchedOptions: any = null

  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchedUrl = String(url)
    fetchedOptions = init
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch

  const client = new DefaultSafeHttpClient({
    pluginId: 'test-plugin',
    version: '1.0.0',
    allowedHosts: ['api.openai.com', '*.volces.com'],
    fetchImpl: mockFetch,
  })

  // Reject HTTP
  await assert.rejects(
    () => client.get('http://api.openai.com/test'),
    (err: unknown) => {
      assert.equal(err instanceof NormalizedProviderError, true)
      assert.equal((err as NormalizedProviderError).diagnostic.code, 'UNSAFE_URL')
      assert.match((err as NormalizedProviderError).diagnostic.detail, /Insecure protocol/)
      return true
    },
  )

  // Reject disallowed host
  await assert.rejects(
    () => client.get('https://malicious.example.com/test'),
    (err: unknown) => {
      assert.equal(err instanceof NormalizedProviderError, true)
      assert.equal((err as NormalizedProviderError).diagnostic.code, 'UNSAFE_URL')
      assert.match((err as NormalizedProviderError).diagnostic.detail, /not in allowed hosts/)
      return true
    },
  )

  // Allow explicit host
  const res1 = await client.get('https://api.openai.com/v1/models')
  assert.equal(res1.ok, true)
  assert.equal(fetchedUrl, 'https://api.openai.com/v1/models')

  // Allow wildcard host
  const res2 = await client.post('https://ark.cn-beijing.volces.com/api/v3/images', '{"hello":"world"}')
  assert.equal(res2.ok, true)
  assert.equal(fetchedUrl, 'https://ark.cn-beijing.volces.com/api/v3/images')
  assert.equal(fetchedOptions.method, 'POST')
})

test('readBoundedOutput bounds memory and extracts image dimensions', async () => {
  // Build a valid 16x16 PNG header
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d,                         // IHDR length 13
    0x49, 0x48, 0x44, 0x52,                         // IHDR
    0x00, 0x00, 0x00, 0x10,                         // width: 16
    0x00, 0x00, 0x00, 0x10,                         // height: 16
    0x08, 0x06, 0x00, 0x00, 0x00,                   // 8-bit RGBA
    0x00, 0x00, 0x00, 0x00,                         // CRC
  ])

  const dim = extractImageDimensions(pngHeader)
  assert.equal(dim.width, 16)
  assert.equal(dim.height, 16)

  const descriptor: OutputDescriptor = {
    index: 0,
    mimeType: 'image/png',
    b64Json: pngHeader.toString('base64'),
  }

  const dummyClient = new DefaultSafeHttpClient({
    pluginId: 'test',
    version: '1.0.0',
    allowedHosts: [],
  })

  const bounded = await readBoundedOutput(descriptor, dummyClient)
  assert.equal(bounded.width, 16)
  assert.equal(bounded.height, 16)
  assert.equal(bounded.sizeBytes, pngHeader.length)
  assert.equal(bounded.data.equals(pngHeader), true)

  // Enforces maxBytes
  await assert.rejects(
    () => readBoundedOutput(descriptor, dummyClient, { maxBytes: 5 }),
    (err: unknown) => {
      assert.equal(err instanceof NormalizedProviderError, true)
      assert.equal((err as NormalizedProviderError).diagnostic.code, 'OUTPUT_READ_FAILED')
      return true
    },
  )
})
