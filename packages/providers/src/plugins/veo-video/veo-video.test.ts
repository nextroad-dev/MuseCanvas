import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DefaultSafeHttpClient } from '../../core/http'
import { readBoundedOutput } from '../../core/output-reader'
import type { ExecutionContext, MediaRequest, OutputDescriptor, ProviderConfig } from '../../core/types'
import {
  VEO_FAST_MODEL,
  VEO_STANDARD_MODEL,
  veoVideoManifest,
  veoVideoPlugin,
} from './index'

const { privateKey: SA_PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const PROJECT = 'demo-project'
const LOCATION = 'us-central1'
const OPERATION = `projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${VEO_STANDARD_MODEL}/operations/op-123`

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    credential: {
      schema: 'json-v1',
      extra: { projectId: PROJECT, location: LOCATION, accessToken: 'ya29.mock-token' },
    },
    ...overrides,
  }
}

function makeContext(mockFetch: typeof globalThis.fetch): ExecutionContext {
  const http = new DefaultSafeHttpClient({
    pluginId: veoVideoManifest.id,
    version: veoVideoManifest.version,
    allowedHosts: [...veoVideoManifest.allowedHosts, 'example.com'],
    fetchImpl: mockFetch,
  })
  return {
    pluginId: veoVideoManifest.id,
    version: veoVideoManifest.version,
    http,
    readOutput: (descriptor: OutputDescriptor, options?: { maxBytes?: number; timeoutMs?: number }) =>
      readBoundedOutput(
        descriptor,
        http,
        { maxBytes: options?.maxBytes, timeoutMs: options?.timeoutMs },
        veoVideoManifest.id,
        veoVideoManifest.version,
      ),
  }
}

function mockRequest(overrides: Partial<MediaRequest> = {}): MediaRequest {
  return {
    modality: 'video',
    vendorModelId: VEO_STANDARD_MODEL,
    prompt: 'A drone shot over a mountain lake at dawn',
    durationSeconds: 8,
    size: '16:9',
    count: 1,
    ...overrides,
  }
}

test('Veo submit posts exact endpoint/body with Bearer token and returns waiting', async () => {
  let capturedUrl = ''
  let capturedAuth = ''
  let capturedBody: any = null

  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url)
    capturedAuth = new Headers(init?.headers).get('authorization') ?? ''
    capturedBody = JSON.parse(String(init?.body || '{}'))
    return new Response(JSON.stringify({ name: OPERATION }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch

  const config = makeConfig()
  const context = makeContext(mockFetch)
  const result = await veoVideoPlugin.submit(mockRequest(), config, context)

  assert.equal(
    capturedUrl,
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${VEO_STANDARD_MODEL}:predictLongRunning`,
  )
  assert.equal(capturedAuth, 'Bearer ya29.mock-token')
  assert.deepEqual(capturedBody.instances, [{ prompt: 'A drone shot over a mountain lake at dawn' }])
  assert.equal(capturedBody.parameters.aspectRatio, '16:9')
  assert.equal(capturedBody.parameters.durationSeconds, 8)
  assert.equal(capturedBody.parameters.sampleCount, 1)

  assert.equal(result.status, 'waiting')
  assert.equal(result.remoteId, OPERATION)
  assert.equal(result.opaqueState?.resourceName, OPERATION)
  // No tokens or URLs persisted in opaque state.
  assert.equal(JSON.stringify(result.opaqueState).includes('ya29'), false)
})

test('Veo submit maps input images to image/lastFrame/referenceImages roles', async () => {
  let capturedBody: any = null
  const img = (byte: number) => ({
    data: Buffer.from([byte, 0x01, 0x02]),
    mimeType: 'image/png' as const,
    sizeBytes: 3,
  })

  const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body || '{}'))
    return new Response(JSON.stringify({ name: OPERATION }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch

  const config = makeConfig()
  const context = makeContext(mockFetch)
  const result = await veoVideoPlugin.submit(
    mockRequest({ inputImages: [img(1), img(2), img(3)] }),
    config,
    context,
  )
  assert.equal(result.status, 'waiting')
  const instance = capturedBody.instances[0]
  assert.equal(instance.image.mimeType, 'image/png')
  assert.equal(instance.lastFrame.mimeType, 'image/png')
  assert.equal(instance.referenceImages.length, 1)
  assert.ok(instance.image.bytesBase64Encoded.length > 0)
})

test('Veo validateRequest enforces Veo 3.1 bounds', async () => {
  const config = makeConfig()
  const context = makeContext(globalThis.fetch)

  // Bad duration.
  await assert.rejects(() => veoVideoPlugin.submit(mockRequest({ durationSeconds: 5 }), config, context))
  // Bad aspect.
  await assert.rejects(() => veoVideoPlugin.submit(mockRequest({ size: '4:3' }), config, context))
  // 1080p requires standard model + 8s.
  await assert.rejects(() =>
    veoVideoPlugin.submit(
      mockRequest({ vendorModelId: VEO_FAST_MODEL, extra: { resolution: '1080p' } }),
      config,
      context,
    ),
  )
  await assert.rejects(() =>
    veoVideoPlugin.submit(
      mockRequest({ durationSeconds: 4, extra: { resolution: '4k' } }),
      config,
      context,
    ),
  )
  // sampleCount out of range.
  await assert.rejects(() => veoVideoPlugin.submit(mockRequest({ count: 5 }), config, context))
  // Oversized input image rejected at the request boundary.
  await assert.rejects(() =>
    veoVideoPlugin.submit(
      mockRequest({
        inputImages: [{ data: Buffer.alloc(8), mimeType: 'image/png', sizeBytes: 21 * 1024 * 1024 }],
      }),
      config,
      context,
    ),
  )
  // Unknown model rejected.
  await assert.rejects(() =>
    veoVideoPlugin.submit(mockRequest({ vendorModelId: 'veo-2.0-generate-001' }), config, context),
  )
})

test('Veo poll maps waiting/success-gcs/success-inline/safety-filter', async () => {
  const config = makeConfig()

  const runPoll = async (payload: unknown) => {
    let capturedUrl = ''
    let capturedBody: any = null
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = JSON.parse(String(init?.body || '{}'))
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    const context = makeContext(mockFetch)
    const opaqueState = { resourceName: OPERATION, location: LOCATION }
    const result = await veoVideoPlugin.poll(OPERATION, opaqueState, config, context)
    return { result, capturedUrl, capturedBody }
  }

  // Not done → waiting, exact poll endpoint/body.
  const pending = await runPoll({ name: OPERATION, done: false })
  assert.equal(pending.result.status, 'waiting')
  assert.equal(
    pending.capturedUrl,
    `https://${LOCATION}-aiplatform.googleapis.com/v1/${OPERATION}:fetchPredictOperation`,
  )
  assert.deepEqual(pending.capturedBody, { operationName: OPERATION })

  // Success with GCS URI.
  const gcs = await runPoll({
    name: OPERATION,
    done: true,
    response: { videos: [{ gcsUri: 'gs://bucket/video.mp4', mimeType: 'video/mp4' }] },
  })
  assert.equal(gcs.result.status, 'succeeded')
  assert.equal(gcs.result.outputs?.length, 1)
  assert.equal(gcs.result.outputs?.[0].mimeType, 'video/mp4')
  assert.equal(gcs.result.outputs?.[0].url, 'https://storage.googleapis.com/bucket/video.mp4')

  // Success with inline base64.
  const inline = await runPoll({
    name: OPERATION,
    done: true,
    response: { videos: [{ bytesBase64Encoded: 'aGVsbG8=', mimeType: 'video/mp4' }] },
  })
  assert.equal(inline.result.status, 'succeeded')
  assert.equal(inline.result.outputs?.[0].b64Json, 'aGVsbG8=')

  // Safety filter: done + filtered count + no videos → failed.
  const blocked = await runPoll({
    name: OPERATION,
    done: true,
    response: { videos: [], raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['rai'] },
  })
  assert.equal(blocked.result.status, 'failed')
  assert.match(blocked.result.error?.detail ?? '', /safety/i)
})

test('Veo poll maps operation error to failed', async () => {
  const mockFetch = (async () => {
    return new Response(
      JSON.stringify({
        name: OPERATION,
        done: true,
        error: { code: 3, message: 'Invalid prompt', status: 'INVALID_ARGUMENT' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof globalThis.fetch

  const config = makeConfig()
  const context = makeContext(mockFetch)
  const result = await veoVideoPlugin.poll(
    OPERATION,
    { resourceName: OPERATION, location: LOCATION },
    config,
    context,
  )
  assert.equal(result.status, 'failed')
  assert.match(result.error?.detail ?? '', /Invalid prompt/)
})

test('Veo cancel returns canceled on ok and waiting on 404', async () => {
  const config = makeConfig()
  const opaqueState = { resourceName: OPERATION, location: LOCATION }

  const okFetch = (async (url: string | URL | Request) => {
    assert.match(String(url), /:cancel$/)
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  const okResult = await veoVideoPlugin.cancel(OPERATION, opaqueState, config, makeContext(okFetch))
  assert.equal(okResult.status, 'canceled')

  const missingFetch = (async () => {
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  const missingResult = await veoVideoPlugin.cancel(
    OPERATION,
    opaqueState,
    config,
    makeContext(missingFetch),
  )
  assert.equal(missingResult.status, 'waiting')
})

test('Veo openOutput supports inline/https and rejects raw GCS URIs', async () => {
  const videoBytes = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
  const mockFetch = (async () => {
    return new Response(videoBytes, { status: 200, headers: { 'content-type': 'video/mp4' } })
  }) as typeof globalThis.fetch

  const config = makeConfig()
  const context = makeContext(mockFetch)

  const inline = await veoVideoPlugin.openOutput!({ index: 0, mimeType: 'video/mp4', b64Json: videoBytes.toString('base64') }, config, context)
  assert.equal(inline.mimeType, 'video/mp4')
  assert.equal(inline.data.equals(videoBytes), true)

  const https = await veoVideoPlugin.openOutput!(
    { index: 0, mimeType: 'video/mp4', url: 'https://us-central1-aiplatform.googleapis.com/video.mp4' },
    config,
    context,
  )
  assert.equal(https.data.equals(videoBytes), true)

  await assert.rejects(
    veoVideoPlugin.openOutput!({ index: 0, mimeType: 'video/mp4', url: 'gs://bucket/video.mp4' }, config, context),
    /UNSAFE_URL/,
  )
})

test('Veo submit mints a service-account token and sends it as the Bearer', async () => {
  const tokenCalls: string[] = []
  let capturedAuth = ''
  let capturedUrl = ''
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    if (target === 'https://oauth2.googleapis.com/token') {
      tokenCalls.push(String(init?.body ?? ''))
      return new Response(JSON.stringify({ access_token: 'sa.minted-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    capturedUrl = target
    capturedAuth = new Headers(init?.headers).get('authorization') ?? ''
    return new Response(JSON.stringify({ name: OPERATION }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch

  const config = makeConfig({
    credential: {
      schema: 'json-v1',
      extra: {
        projectId: PROJECT,
        location: LOCATION,
        client_email: 'mint-test@demo-project.iam.gserviceaccount.com',
        private_key: SA_PRIVATE_KEY_PEM,
      },
    },
  })
  const context = makeContext(mockFetch)
  const result = await veoVideoPlugin.submit(mockRequest(), config, context)

  assert.equal(tokenCalls.length, 1)
  assert.equal(capturedAuth, 'Bearer sa.minted-token')
  assert.match(
    capturedUrl,
    /aiplatform\.googleapis\.com\/v1\/projects\/demo-project\/locations\/us-central1\/publishers\/google\/models\/.*:predictLongRunning$/,
  )
  assert.equal(result.status, 'waiting')
  assert.equal(result.remoteId, OPERATION)
})

test('Veo submit reuses the cached service-account token on the second call', async () => {
  let tokenCalls = 0
  const mockFetch = (async (url: string | URL | Request) => {
    const target = String(url)
    if (target === 'https://oauth2.googleapis.com/token') {
      tokenCalls += 1
      return new Response(JSON.stringify({ access_token: 'sa.cached-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ name: OPERATION }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch

  const config = makeConfig({
    credential: {
      schema: 'json-v1',
      extra: {
        projectId: PROJECT,
        location: LOCATION,
        client_email: 'cache-test@demo-project.iam.gserviceaccount.com',
        private_key: SA_PRIVATE_KEY_PEM,
      },
    },
  })
  const context = makeContext(mockFetch)
  const first = await veoVideoPlugin.submit(mockRequest(), config, context)
  const second = await veoVideoPlugin.submit(mockRequest(), config, context)

  assert.equal(first.status, 'waiting')
  assert.equal(second.status, 'waiting')
  assert.equal(tokenCalls, 1)
})

test('Veo probe uses GET operations without triggering generation', async () => {
  const seen: Array<{ method?: string; url: string; body: string }> = []
  const record = (status: number, payload: unknown = {}) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ method: init?.method, url: String(url), body: String(init?.body ?? '') })
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
  const cfg = makeConfig()

  const okCtx = makeContext(record(200, { operations: [] }))
  const healthy = await veoVideoPlugin.probe(cfg, okCtx)
  assert.equal(healthy.healthy, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'GET')
  assert.equal(
    seen[0].url,
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/operations?pageSize=1`,
  )
  assert.equal(seen[0].body, '')
  assert.equal(seen[0].url.includes('predictLongRunning'), false)

  seen.length = 0
  const deniedCtx = makeContext(record(401, { error: { message: 'UNAUTHENTICATED' } }))
  const denied = await veoVideoPlugin.probe(cfg, deniedCtx)
  assert.equal(denied.healthy, false)
  assert.ok(String(denied.message).includes('401'))
  assert.equal(seen[0].method, 'GET')
  assert.equal(seen[0].url.includes('predictLongRunning'), false)

  const downCtx = makeContext(record(503, { error: { message: 'UNAVAILABLE' } }))
  const down = await veoVideoPlugin.probe(cfg, downCtx)
  assert.equal(down.healthy, false)
})

test('Veo maps extra.audio alias to generateAudio with explicit key winning', async () => {
  const submitWithExtra = async (extra: Record<string, unknown>) => {
    let capturedGenerateAudio: unknown
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const parsed: unknown = JSON.parse(String(init?.body || '{}'))
      if (parsed !== null && typeof parsed === 'object' && 'parameters' in parsed) {
        const params = parsed.parameters
        if (params !== null && typeof params === 'object' && 'generateAudio' in params) {
          capturedGenerateAudio = params.generateAudio
        }
      }
      return new Response(JSON.stringify({ name: OPERATION }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    const result = await veoVideoPlugin.submit(mockRequest({ extra }), makeConfig(), makeContext(mockFetch))
    assert.equal(result.status, 'waiting')
    return capturedGenerateAudio
  }
  const aliased = await submitWithExtra({ audio: true })
  assert.equal(aliased, true)

  const explicit = await submitWithExtra({ generateAudio: false, audio: true })
  assert.equal(explicit, false)

  const legacy = await submitWithExtra({ generateAudio: true })
  assert.equal(legacy, true)

})
