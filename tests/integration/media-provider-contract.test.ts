// Deterministic media provider contract coverage for the unified image/video system.
//
// Runner: node --import tsx --test tests/integration/media-provider-contract.test.ts
// Network-free and credential-free: every provider call runs against an injected
// mock SafeHttpClient / mock fetch. No paid providers, DB, Redis, or S3 involved.
//
// NOTE: the import below resolves to the public @musecanvas/providers entry
// (package.json exports["."] -> ./src/index.ts) via a relative path so this
// root-level integration test does not need a workspace dependency edge.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DefaultSafeHttpClient,
  VEO_STANDARD_MODEL,
  globalProviderRegistry,
  openAiImageManifest,
  seedanceVideoManifest,
  seedanceVideoPlugin,
  seedreamImageManifest,
  veoVideoManifest,
  veoVideoPlugin,
  type ExecutionContext,
  type MediaRequest,
  type OutputDescriptor,
  type ProviderConfig,
  type SafeHttpClient,
  type SafeHttpResponse,
} from '../../packages/providers/src/index.ts'

// ---------------------------------------------------------------------------
// Mock HTTP helpers (injected, deterministic, no network)
// ---------------------------------------------------------------------------

type CapturedCall = {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  url = 'https://mock.invalid/',
): SafeHttpResponse {
  const h = new Headers({ 'content-type': 'application/json', ...headers })
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: h,
    ok: status >= 200 && status < 300,
    url,
    text: async () => JSON.stringify(body),
    json: async <T>() => body as T,
    buffer: async () => Buffer.from(JSON.stringify(body)),
    stream: () => new ReadableStream<Uint8Array>(),
  }
}

function createMockHttp(handler: (call: CapturedCall) => SafeHttpResponse | Promise<SafeHttpResponse>): {
  client: SafeHttpClient
  calls: CapturedCall[]
} {
  const calls: CapturedCall[] = []
  const client: SafeHttpClient = {
    request: async (url: string, init = {}) => {
      const call: CapturedCall = {
        url,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
        body: typeof init.body === 'string' ? init.body : undefined,
      }
      calls.push(call)
      return handler(call)
    },
    get: async (url: string, init = {}) => client.request(url, { ...init, method: 'GET' }),
    post: async (url: string, body, init = {}) => client.request(url, { ...init, method: 'POST', body: body as string }),
  }
  return { client, calls }
}

function stubContext(pluginId: string, version: string, handler: (call: CapturedCall) => SafeHttpResponse): {
  context: ExecutionContext
  calls: CapturedCall[]
} {
  const { client, calls } = createMockHttp(handler)
  const context: ExecutionContext = {
    pluginId,
    version,
    http: client,
    readOutput: async descriptor => ({
      data: Buffer.from('fake-bytes'),
      mimeType: descriptor.mimeType,
      sizeBytes: 10,
      metadata: { stub: true },
    }),
  }
  return { context, calls }
}

function assertOpaqueHygiene(opaqueState: Record<string, unknown> | undefined, secrets: string[]): void {
  assert.ok(opaqueState && typeof opaqueState === 'object', 'expected an opaqueState object')
  const serialized = JSON.stringify(opaqueState)
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, `opaqueState must not contain secret material (${secret.slice(0, 8)}…)`)
  }
  // Signed URLs / query-string signatures must never be persisted either.
  assert.equal(/signature=/i.test(serialized), false, 'opaqueState must not contain signed URL material')
  assert.equal(/sig=/i.test(serialized), false, 'opaqueState must not contain signed URL material')
}

function assertDiscriminatedOutputs(outputs: OutputDescriptor[] | undefined): void {
  assert.ok(Array.isArray(outputs) && outputs.length > 0, 'expected at least one output descriptor')
  for (const [position, output] of outputs!.entries()) {
    assert.equal(output.index, position, 'output index must be dense and zero-based')
    assert.ok(typeof output.mimeType === 'string' && output.mimeType.length > 0, 'output must carry a mimeType')
    const hasUrl = typeof output.url === 'string' && output.url.length > 0
    const hasB64 = typeof output.b64Json === 'string' && output.b64Json.length > 0
    assert.ok(hasUrl !== hasB64, 'output must be discriminated: exactly one of url / b64Json')
    if (hasUrl) {
      const parsed = new URL(output.url!)
      assert.equal(parsed.protocol, 'https:', 'remote output URLs must be https')
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Registry: all four exact plugin keys
// ---------------------------------------------------------------------------

test('registry exposes openai-image@1.0.0, seedream-image@1.0.0, seedance-video@1.0.0, veo-video@1.0.0', () => {
  for (const [id, version] of [
    ['openai-image', '1.0.0'],
    ['seedream-image', '1.0.0'],
    ['seedance-video', '1.0.0'],
    ['veo-video', '1.0.0'],
  ] as const) {
    assert.equal(globalProviderRegistry.has(id, version), true, `expected ${id}@${version} to be registered`)
    const plugin = globalProviderRegistry.get(id, version)
    assert.equal(plugin.manifest.id, id)
    assert.equal(plugin.manifest.version, version)
  }
  const keys = new Set(globalProviderRegistry.listManifests().map(m => `${m.id}@${m.version}`))
  for (const key of ['openai-image@1.0.0', 'seedream-image@1.0.0', 'seedance-video@1.0.0', 'veo-video@1.0.0']) {
    assert.ok(keys.has(key), `listManifests() must include ${key}`)
  }
})

// ---------------------------------------------------------------------------
// 2. Manifests: modalities, versions, host allowlists
// ---------------------------------------------------------------------------

test('image manifests declare image modality, 1.0.0, and OpenAI/Ark host allowlists', () => {
  assert.equal(openAiImageManifest.version, '1.0.0')
  assert.deepEqual(openAiImageManifest.modalities, ['image'])
  assert.ok(openAiImageManifest.allowedHosts.includes('api.openai.com'))
  assert.ok(openAiImageManifest.credentialSchemas.includes('legacy-api-key-v1'))

  assert.equal(seedreamImageManifest.version, '1.0.0')
  assert.deepEqual(seedreamImageManifest.modalities, ['image'])
  assert.ok(seedreamImageManifest.allowedHosts.includes('ark.cn-beijing.volces.com'))
  assert.ok(seedreamImageManifest.credentialSchemas.includes('json-v1'))
})

test('video manifests declare video modality, 1.0.0, and Ark/Vertex host allowlists', () => {
  assert.equal(seedanceVideoManifest.version, '1.0.0')
  assert.deepEqual(seedanceVideoManifest.modalities, ['video'])
  assert.ok(seedanceVideoManifest.allowedHosts.includes('ark.cn-beijing.volces.com'))
  assert.ok(seedanceVideoManifest.allowedHosts.includes('ark.ap-southeast.bytepluses.com'))
  const seedanceModels = (seedanceVideoManifest.models ?? []).map(m => m.id)
  assert.ok(seedanceModels.includes('doubao-seedance-2-0-fast-260128'))
  assert.ok(seedanceModels.includes('dreamina-seedance-2-0-fast-260128'))

  assert.equal(veoVideoManifest.version, '1.0.0')
  assert.deepEqual(veoVideoManifest.modalities, ['video'])
  assert.ok(veoVideoManifest.allowedHosts.includes('aiplatform.googleapis.com'))
  assert.ok(veoVideoManifest.credentialSchemas.includes('json-v1'))
  const veoModels = (veoVideoManifest.models ?? []).map(m => m.id)
  assert.ok(veoModels.includes(VEO_STANDARD_MODEL))
})

// ---------------------------------------------------------------------------
// 3. Safe HTTP boundaries: HTTPS-only, host allowlist, redirect cap, size cap
// ---------------------------------------------------------------------------

test('safe HTTP rejects plain http URLs', async () => {
  const client = new DefaultSafeHttpClient({
    pluginId: 'contract-probe',
    version: '1.0.0',
    allowedHosts: ['ark.cn-beijing.volces.com'],
    fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch,
  })
  await assert.rejects(
    () => client.get('http://ark.cn-beijing.volces.com/api/v3/models'),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /https/i)
      return true
    },
  )
})

test('safe HTTP rejects hosts outside the plugin allowlist', async () => {
  let fetchCalls = 0
  const client = new DefaultSafeHttpClient({
    pluginId: 'contract-probe',
    version: '1.0.0',
    allowedHosts: ['ark.cn-beijing.volces.com'],
    fetchImpl: (async () => {
      fetchCalls++
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch,
  })
  await assert.rejects(() => client.get('https://evil.example.com/payload'), /allowlist|allowed|host/i)
  assert.equal(fetchCalls, 0, 'disallowed hosts must be rejected before any fetch')
})

test('safe HTTP revalidates redirect targets and enforces the redirect cap', async () => {
  // Redirect to a disallowed host must fail.
  const redirectFetch = (async () =>
    new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } })) as typeof globalThis.fetch
  const client = new DefaultSafeHttpClient({
    pluginId: 'contract-probe',
    version: '1.0.0',
    allowedHosts: ['allowed.example.com'],
    fetchImpl: redirectFetch,
  })
  await assert.rejects(() => client.get('https://allowed.example.com/start'), /allowlist|allowed|host/i)

  // Endless same-host redirects must hit the redirect limit (5).
  let loopCalls = 0
  const loopFetch = (async () => {
    loopCalls++
    return new Response(null, { status: 302, headers: { location: 'https://allowed.example.com/loop' } })
  }) as typeof globalThis.fetch
  const looping = new DefaultSafeHttpClient({
    pluginId: 'contract-probe',
    version: '1.0.0',
    allowedHosts: ['allowed.example.com'],
    fetchImpl: loopFetch,
  })
  await assert.rejects(() => looping.get('https://allowed.example.com/loop'), /redirect/i)
  assert.ok(loopCalls > 1 && loopCalls <= 6, `expected bounded redirect chain, got ${loopCalls} fetches`)
})

test('safe HTTP enforces the maxBytes body/size boundary', async () => {
  const bigBody = 'x'.repeat(64)
  const client = new DefaultSafeHttpClient({
    pluginId: 'contract-probe',
    version: '1.0.0',
    allowedHosts: ['allowed.example.com'],
    fetchImpl: (async () => new Response(bigBody, { status: 200 })) as typeof globalThis.fetch,
  })
  const res = await client.get('https://allowed.example.com/blob', { maxBytes: 16 })
  await assert.rejects(() => res.buffer(), /exceed/i)

  // A lying content-length header fails fast without reading the body.
  const lyingFetch = (async () =>
    new Response('tiny', { status: 200, headers: { 'content-length': '999999999' } })) as typeof globalThis.fetch
  const strict = new DefaultSafeHttpClient({
    pluginId: 'contract-probe',
    version: '1.0.0',
    allowedHosts: ['allowed.example.com'],
    fetchImpl: lyingFetch,
  })
  const lying = await strict.get('https://allowed.example.com/blob', { maxBytes: 16 })
  await assert.rejects(() => lying.text(), /exceed/i)
})

// ---------------------------------------------------------------------------
// 4. Seedance Ark fixtures: submit / poll / cancel
// ---------------------------------------------------------------------------

const SEEDANCE_CONFIG: ProviderConfig = {
  credential: { schema: 'legacy-api-key-v1', apiKey: 'seedance-test-key' },
}

const SEEDANCE_REQUEST: MediaRequest = {
  modality: 'video',
  vendorModelId: 'doubao-seedance-2-0-fast-260128',
  prompt: 'a panda riding a bicycle through a bamboo forest',
  durationSeconds: 5,
}

test('Seedance submit posts the Ark tasks endpoint and returns waiting + hygienic opaque state', async () => {
  const { context, calls } = stubContext(seedanceVideoManifest.id, seedanceVideoManifest.version, call => {
    assert.equal(call.method, 'POST')
    return jsonResponse(200, { id: 'cgt-fixture-1', status: 'queued' })
  })
  const result = await seedanceVideoPlugin.submit(SEEDANCE_REQUEST, SEEDANCE_CONFIG, context)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')
  assert.equal(calls[0].headers['authorization'], 'Bearer seedance-test-key')
  const body = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>
  assert.equal(body['model'], SEEDANCE_REQUEST.vendorModelId, 'submit body must carry the vendor model id')
  assert.ok(Array.isArray(body['content']), 'submit body must carry a content array')
  assert.equal(result.status, 'waiting')
  assert.equal(result.remoteId, 'cgt-fixture-1')
  assertOpaqueHygiene(result.opaqueState, ['seedance-test-key'])
  assert.equal(result.opaqueState?.['taskId'], 'cgt-fixture-1')
})

test('Seedance poll maps queued -> waiting and succeeded -> discriminated video output', async () => {
  const waiting = stubContext(seedanceVideoManifest.id, seedanceVideoManifest.version, () =>
    jsonResponse(200, { status: 'running', progress: 42 }),
  )
  const pending = await seedanceVideoPlugin.poll('cgt-fixture-1', { taskId: 'cgt-fixture-1' }, SEEDANCE_CONFIG, waiting.context)
  assert.equal(pending.status, 'waiting')
  assert.equal(pending.remoteId, 'cgt-fixture-1')

  const videoUrl = 'https://ark.cn-beijing.volces.com/video-output/fixture.mp4'
  const done = stubContext(seedanceVideoManifest.id, seedanceVideoManifest.version, () =>
    jsonResponse(200, { status: 'succeeded', content: { video_url: videoUrl, duration: 5 } }),
  )
  const finished = await seedanceVideoPlugin.poll(
    'cgt-fixture-1',
    { taskId: 'cgt-fixture-1', model: SEEDANCE_REQUEST.vendorModelId },
    SEEDANCE_CONFIG,
    done.context,
  )
  assert.equal(finished.status, 'succeeded')
  assertDiscriminatedOutputs(finished.outputs)
  assert.equal(finished.outputs?.[0].mimeType, 'video/mp4')
  assert.equal(finished.outputs?.[0].url, videoUrl)
  assertOpaqueHygiene(finished.opaqueState, ['seedance-test-key'])
})

test('Seedance poll rejects off-allowlist video URLs and cancel treats 404 as canceled', async () => {
  const offAllowlist = stubContext(seedanceVideoManifest.id, seedanceVideoManifest.version, () =>
    jsonResponse(200, { status: 'succeeded', content: { video_url: 'https://evil.example.com/v.mp4' } }),
  )
  const rejected = await seedanceVideoPlugin.poll(
    'cgt-fixture-1',
    { taskId: 'cgt-fixture-1' },
    SEEDANCE_CONFIG,
    offAllowlist.context,
  )
  assert.equal(rejected.status, 'failed')
  assert.equal(rejected.error?.code, 'UNSAFE_URL')

  const cancelCtx = stubContext(seedanceVideoManifest.id, seedanceVideoManifest.version, call => {
    assert.equal(call.method, 'DELETE')
    assert.ok(call.url.endsWith('/contents/generations/tasks/cgt-fixture-1'))
    return jsonResponse(404, { error: 'not found' })
  })
  const canceled = await seedanceVideoPlugin.cancel('cgt-fixture-1', { taskId: 'cgt-fixture-1' }, SEEDANCE_CONFIG, cancelCtx.context)
  assert.equal(canceled.status, 'canceled')
  assertOpaqueHygiene(canceled.opaqueState, ['seedance-test-key'])
})

// ---------------------------------------------------------------------------
// 5. Veo Enterprise fixtures: predictLongRunning / fetchPredictOperation / cancel
// ---------------------------------------------------------------------------

const VEO_PROJECT = 'contract-project'
const VEO_LOCATION = 'us-central1'
const VEO_OPERATION = `projects/${VEO_PROJECT}/locations/${VEO_LOCATION}/publishers/google/models/${VEO_STANDARD_MODEL}/operations/op-fixture`
const VEO_SUBMIT_URL =
  `https://${VEO_LOCATION}-aiplatform.googleapis.com/v1/projects/${VEO_PROJECT}` +
  `/locations/${VEO_LOCATION}/publishers/google/models/${VEO_STANDARD_MODEL}:predictLongRunning`

function veoConfig(): ProviderConfig {
  return {
    credential: {
      schema: 'json-v1',
      extra: { projectId: VEO_PROJECT, location: VEO_LOCATION, accessToken: 'ya29.contract-token' },
    },
  }
}

function veoRequest(): MediaRequest {
  return {
    modality: 'video',
    vendorModelId: VEO_STANDARD_MODEL,
    prompt: 'a drone shot over a mountain lake at dawn',
    durationSeconds: 8,
    size: '16:9',
    count: 1,
  }
}

test('Veo submit posts predictLongRunning and returns waiting + hygienic opaque state', async () => {
  const { context, calls } = stubContext(veoVideoManifest.id, veoVideoManifest.version, () =>
    jsonResponse(200, { name: VEO_OPERATION }),
  )
  const result = await veoVideoPlugin.submit(veoRequest(), veoConfig(), context)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, VEO_SUBMIT_URL)
  assert.equal(calls[0].headers['authorization'], 'Bearer ya29.contract-token')
  const body = JSON.parse(calls[0].body ?? '{}') as { instances: unknown[]; parameters: Record<string, unknown> }
  assert.equal(body.instances.length, 1)
  assert.equal(body.parameters['durationSeconds'], 8)
  assert.equal(result.status, 'waiting')
  assert.equal(result.remoteId, VEO_OPERATION)
  assert.equal(result.opaqueState?.['resourceName'], VEO_OPERATION)
  assertOpaqueHygiene(result.opaqueState, ['ya29.contract-token'])
})

test('Veo poll maps not-done -> waiting and done -> discriminated outputs', async () => {
  const config = veoConfig()
  const pendingCtx = stubContext(veoVideoManifest.id, veoVideoManifest.version, call => {
    assert.ok(call.url.endsWith(':fetchPredictOperation'), `poll must hit fetchPredictOperation, got ${call.url}`)
    return jsonResponse(200, { name: VEO_OPERATION, done: false })
  })
  const pending = await veoVideoPlugin.poll(VEO_OPERATION, { resourceName: VEO_OPERATION }, config, pendingCtx.context)
  assert.equal(pending.status, 'waiting')

  const doneCtx = stubContext(veoVideoManifest.id, veoVideoManifest.version, () =>
    jsonResponse(200, {
      name: VEO_OPERATION,
      done: true,
      response: { videos: [{ gcsUri: 'gs://contract-bucket/fixture.mp4', mimeType: 'video/mp4' }] },
    }),
  )
  const finished = await veoVideoPlugin.poll(VEO_OPERATION, { resourceName: VEO_OPERATION }, config, doneCtx.context)
  assert.equal(finished.status, 'succeeded')
  assertDiscriminatedOutputs(finished.outputs)
  assertOpaqueHygiene(finished.opaqueState, ['ya29.contract-token'])
})

test('Veo cancel posts the :cancel endpoint and keeps opaque state hygienic', async () => {
  const config = veoConfig()
  const { context, calls } = stubContext(veoVideoManifest.id, veoVideoManifest.version, () => jsonResponse(200, {}))
  const result = await veoVideoPlugin.cancel(VEO_OPERATION, { resourceName: VEO_OPERATION }, config, context)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.endsWith(':cancel'), `cancel must hit :cancel, got ${calls[0].url}`)
  assert.equal(result.status, 'canceled')
  assertOpaqueHygiene(result.opaqueState, ['ya29.contract-token'])
})
