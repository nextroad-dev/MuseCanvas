import test from 'node:test'
import assert from 'node:assert/strict'
import {
  seedanceVideoPlugin,
  seedanceVideoManifest,
  SEEDANCE_CN_BASE_URL,
  SEEDANCE_BYTEPLUS_BASE_URL,
} from './index'
import type {
  BoundedOutput,
  ExecutionContext,
  MediaRequest,
  OutputDescriptor,
  ProviderConfig,
  SafeHttpClient,
  SafeHttpResponse,
} from '../../core/types'

type CapturedCall = { url: string; method: string; headers: Record<string, string>; body?: string }

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}, url = 'https://x'): SafeHttpResponse {
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

function createMockHttp(handler: (call: CapturedCall) => SafeHttpResponse): { client: SafeHttpClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const client: SafeHttpClient = {
    request: async (url: string, init = {}) => {
      const call: CapturedCall = {
        url,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(
          Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
        ),
        body: typeof init.body === 'string' ? init.body : undefined,
      }
      calls.push(call)
      return handler(call)
    },
    get: async (url: string, init = {}) => client.request(url, { ...init, method: 'GET' }),
    post: async (url: string, body, init = {}) =>
      client.request(url, { ...init, method: 'POST', body: body as string }),
  }
  return { client, calls }
}

function createContext(
  handler: (call: CapturedCall) => SafeHttpResponse,
  readOutput?: (descriptor: OutputDescriptor) => Promise<BoundedOutput>,
): { context: ExecutionContext; calls: CapturedCall[]; readCalls: { descriptor: OutputDescriptor; options?: unknown }[] } {
  const { client, calls } = createMockHttp(handler)
  const readCalls: { descriptor: OutputDescriptor; options?: unknown }[] = []
  const context: ExecutionContext = {
    pluginId: seedanceVideoManifest.id,
    version: seedanceVideoManifest.version,
    http: client,
    readOutput: async (descriptor: OutputDescriptor, options?: { maxBytes?: number; timeoutMs?: number }) => {
      readCalls.push({ descriptor, options })
      if (readOutput) return readOutput(descriptor)
      return {
        data: Buffer.from('fake-video-bytes'),
        mimeType: descriptor.mimeType,
        sizeBytes: 16,
        metadata: { remoteId: 'cgt-test' },
      }
    },
  }
  return { context, calls, readCalls }
}

const baseConfig: ProviderConfig = { credential: { schema: 'legacy-api-key-v1', apiKey: 'test-key' } }

const baseRequest: MediaRequest = {
  modality: 'video',
  vendorModelId: 'doubao-seedance-2-0-fast-260128',
  prompt: 'a panda riding a bicycle through a bamboo forest',
}

test('manifest declares exact id, modality, hosts, schemas, and 2.x models', () => {
  assert.equal(seedanceVideoManifest.id, 'seedance-video')
  assert.equal(seedanceVideoManifest.version, '1.0.0')
  assert.deepEqual(seedanceVideoManifest.modalities, ['video'])
  assert.ok(seedanceVideoManifest.allowedHosts.includes('ark.cn-beijing.volces.com'))
  assert.ok(seedanceVideoManifest.allowedHosts.includes('ark.ap-southeast.bytepluses.com'))
  assert.ok(seedanceVideoManifest.credentialSchemas.includes('legacy-api-key-v1'))
  assert.ok(seedanceVideoManifest.credentialSchemas.includes('json-v1'))
  const ids = (seedanceVideoManifest.models ?? []).map(m => m.id)
  assert.ok(ids.includes('doubao-seedance-2-0-fast-260128'))
  assert.ok(ids.includes('dreamina-seedance-2-0-fast-260128'))
})

test('submit posts exact Ark URL, auth headers, request id, and maps prompt + controls', async () => {
  const { context, calls } = createContext(() =>
    jsonResponse(200, { id: 'cgt-123', status: 'queued' }, { 'x-request-id': 'req-1' }),
  )
  const request: MediaRequest = {
    ...baseRequest,
    watermark: true,
    durationSeconds: 5,
    extra: { generate_audio: true, camera_fixed: false, seed: 42, resolution: '1080p', ratio: '16:9', frames: 120, unknown_future_flag: true },
  }
  const config: ProviderConfig = { ...baseConfig, clientRequestId: 'client-abc' }

  const result = await seedanceVideoPlugin.submit(request, config, context)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, `${SEEDANCE_CN_BASE_URL}/contents/generations/tasks`)
  assert.equal(calls[0].headers['authorization'], 'Bearer test-key')
  assert.equal(calls[0].headers['content-type'], 'application/json')
  assert.equal(calls[0].headers['x-client-request-id'], 'client-abc')

  const body = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>
  assert.equal(body['model'], 'doubao-seedance-2-0-fast-260128')
  assert.deepEqual(body['content'], [{ type: 'text', text: request.prompt }])
  assert.equal(body['generate_audio'], true)
  assert.equal(body['camera_fixed'], false)
  assert.equal(body['watermark'], true)
  assert.equal(body['seed'], 42)
  assert.equal(body['resolution'], '1080p')
  assert.equal(body['ratio'], '16:9')
  assert.equal(body['duration'], 5)
  assert.equal(body['frames'], 120)
  assert.equal('unknown_future_flag' in body, false)

  assert.equal(result.status, 'waiting')
  assert.equal(result.remoteId, 'cgt-123')
  assert.deepEqual(result.opaqueState, { taskId: 'cgt-123', model: request.vendorModelId, durationSeconds: 5 })
  const opaqueJson = JSON.stringify(result.opaqueState)
  assert.equal(opaqueJson.includes('test-key'), false)
  assert.equal(opaqueJson.includes('http'), false)
})

test('submit maps input images to data-URL entries with frame roles', async () => {
  const { context, calls } = createContext(() => jsonResponse(200, { id: 'cgt-img' }))
  const request: MediaRequest = {
    ...baseRequest,
    inputImages: [
      { data: Buffer.from('first').toString('base64'), mimeType: 'image/png' },
      { data: Buffer.from('last').toString('base64'), mimeType: 'image/jpeg' },
    ],
  }
  await seedanceVideoPlugin.submit(request, baseConfig, context)
  const body = JSON.parse(calls[0].body ?? '{}') as {
    content: Array<{ type: string; image_url?: { url: string }; role?: string }>
  }
  assert.equal(body.content.length, 3)
  assert.equal(body.content[1].type, 'image_url')
  assert.equal(body.content[1].role, 'first_frame')
  assert.ok(body.content[1].image_url?.url.startsWith('data:image/png;base64,'))
  assert.equal(body.content[2].role, 'last_frame')
  assert.ok(body.content[2].image_url?.url.startsWith('data:image/jpeg;base64,'))
})

test('submit honors explicit imageRoles including mask', async () => {
  const { context, calls } = createContext(() => jsonResponse(200, { id: 'cgt-mask' }))
  const request: MediaRequest = {
    ...baseRequest,
    inputImages: [{ data: 'AAAA', mimeType: 'image/png' }],
    extra: { imageRoles: ['mask'] },
  }
  await seedanceVideoPlugin.submit(request, baseConfig, context)
  const body = JSON.parse(calls[0].body ?? '{}') as { content: Array<{ role?: string }> }
  assert.equal(body.content[1].role, 'mask')
})

test('submit resolves BytePlus endpoint when region is configured', async () => {
  const { context, calls } = createContext(() => jsonResponse(200, { id: 'cgt-bp' }))
  const request: MediaRequest = { ...baseRequest, vendorModelId: 'dreamina-seedance-2-0-fast-260128' }
  await seedanceVideoPlugin.submit(request, { ...baseConfig, region: 'byteplus' }, context)
  assert.equal(calls[0].url, `${SEEDANCE_BYTEPLUS_BASE_URL}/contents/generations/tasks`)
})

test('poll maps queued/running to waiting with provider Retry-After timing', async () => {
  const { context } = createContext(() => jsonResponse(200, { status: 'running', progress: 42 }, { 'retry-after': '7' }))
  const result = await seedanceVideoPlugin.poll?.('cgt-123', { taskId: 'cgt-123' }, baseConfig, context)
  assert.equal(result?.status, 'waiting')
  assert.equal(result?.retryAfterMs, 7_000)
  assert.equal(result?.progress, 42)
})

test('poll maps succeeded to a video output descriptor with metadata only', async () => {
  const { context } = createContext(() =>
    jsonResponse(200, { status: 'succeeded', content: { video_url: 'https://ark.cn-beijing.volces.com/videos/out.mp4' } }),
  )
  const result = await seedanceVideoPlugin.poll?.(
    'cgt-123',
    { taskId: 'cgt-123', model: 'doubao-seedance-2-0-fast-260128' },
    baseConfig,
    context,
  )
  assert.equal(result?.status, 'succeeded')
  assert.equal(result?.outputs?.length, 1)
  assert.equal(result?.outputs?.[0].mimeType, 'video/mp4')
  assert.equal(result?.outputs?.[0].url, 'https://ark.cn-beijing.volces.com/videos/out.mp4')
  assert.equal((result?.outputs?.[0].metadata?.['remoteId'] as string), 'cgt-123')
})

test('poll maps failed and cancelled to terminal states with normalized errors', async () => {
  const { context: failedCtx } = createContext(() =>
    jsonResponse(200, { status: 'failed', error: { code: 'GenerationFailed', message: 'content filtered' } }),
  )
  const failed = await seedanceVideoPlugin.poll?.('cgt-9', { taskId: 'cgt-9' }, baseConfig, failedCtx)
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.error?.code, 'PROVIDER_REJECTED')
  assert.match(failed?.error?.detail ?? '', /GenerationFailed/)

  const { context: canceledCtx } = createContext(() => jsonResponse(200, { status: 'cancelled' }))
  const canceled = await seedanceVideoPlugin.poll?.('cgt-9', { taskId: 'cgt-9' }, baseConfig, canceledCtx)
  assert.equal(canceled?.status, 'canceled')
})

test('poll maps transient 503 to waiting with retry timing', async () => {
  const { context } = createContext(() =>
    jsonResponse(503, { error: { message: 'service unavailable' } }, { 'retry-after': '2' }),
  )
  const result = await seedanceVideoPlugin.poll?.('cgt-123', { taskId: 'cgt-123' }, baseConfig, context)
  assert.equal(result?.status, 'waiting')
  assert.equal(result?.error?.code, 'PROVIDER_TEMPORARY_ERROR')
  assert.equal(typeof result?.retryAfterMs, 'number')
  assert.equal(result?.retryAfterMs, 2_000)
})

test('submit maps transient 429 to submission_unknown with retry timing', async () => {
  const { context } = createContext(() =>
    jsonResponse(429, { error: { message: 'rate limited' } }, { 'retry-after': '3' }),
  )
  const result = await seedanceVideoPlugin.submit?.(baseRequest, baseConfig, context)
  assert.equal(result?.status, 'submission_unknown')
  assert.equal(result?.error?.code, 'PROVIDER_TEMPORARY_ERROR')
  assert.equal(result?.retryAfterMs, 3_000)
})

test('submit maps 400 to failed with PROVIDER_REJECTED', async () => {
  const { context } = createContext(() => jsonResponse(400, { error: { message: 'bad request' } }))
  const result = await seedanceVideoPlugin.submit?.(baseRequest, baseConfig, context)
  assert.equal(result?.status, 'failed')
  assert.equal(result?.error?.code, 'PROVIDER_REJECTED')
})

test('cancel issues DELETE to the task endpoint and maps terminal/transient outcomes', async () => {
  const seen: string[] = []
  const { context, calls } = createContext(call => {
    seen.push(`${call.method} ${call.url}`)
    if (call.url.endsWith('/cgt-done')) return jsonResponse(200, { status: 'cancelled' })
    return jsonResponse(200, { status: 'canceling' })
  })

  const done = await seedanceVideoPlugin.cancel?.('cgt-done', { taskId: 'cgt-done' }, baseConfig, context)
  assert.equal(done?.status, 'canceled')

  const draining = await seedanceVideoPlugin.cancel?.('cgt-run', { taskId: 'cgt-run' }, baseConfig, context)
  assert.equal(draining?.status, 'waiting')

  assert.deepEqual(seen, [
    `DELETE ${SEEDANCE_CN_BASE_URL}/contents/generations/tasks/cgt-done`,
    `DELETE ${SEEDANCE_CN_BASE_URL}/contents/generations/tasks/cgt-run`,
  ])
  assert.ok(calls.every(c => c.method === 'DELETE'))
})

test('cancel treats missing task as best-effort canceled', async () => {
  const { context } = createContext(() => jsonResponse(404, { error: { message: 'not found' } }))
  const result = await seedanceVideoPlugin.cancel?.('cgt-gone', { taskId: 'cgt-gone' }, baseConfig, context)
  assert.equal(result?.status, 'canceled')
})

test('openOutput downloads bounded HTTPS provider output and rejects non-video MIME', async () => {
  const { context, readCalls } = createContext(() =>
    jsonResponse(200, { status: 'succeeded', content: { video_url: 'https://ark.cn-beijing.volces.com/x.mp4' } }),
  )
  const descriptor: OutputDescriptor = {
    index: 0,
    mimeType: 'video/mp4',
    url: 'https://ark.cn-beijing.volces.com/videos/out.mp4',
  }
  const bounded = await seedanceVideoPlugin.openOutput?.(
    descriptor,
    { ...baseConfig, maxBytes: 99, timeoutMs: 1234 },
    context,
  )
  assert.equal(bounded?.mimeType, 'video/mp4')
  assert.equal(readCalls.length, 1)
  assert.deepEqual(readCalls[0].options, { maxBytes: 99, timeoutMs: 1234 })

  await assert.rejects(
    () => seedanceVideoPlugin.openOutput?.({ index: 0, mimeType: 'image/png', url: descriptor.url }, baseConfig, context),
    (err: unknown) => (err as Error).message === 'INVALID_REQUEST',
  )
  await assert.rejects(
    () =>
      seedanceVideoPlugin.openOutput?.(
        { index: 0, mimeType: 'video/mp4', url: 'https://evil.example.com/out.mp4' },
        baseConfig,
        context,
      ),
    (err: unknown) => (err as Error).message === 'UNSAFE_URL',
  )
})

test('validateConfig and validateRequest reject missing credentials and bad input', () => {
  assert.throws(
    () => seedanceVideoPlugin.validateConfig({}),
    (err: unknown) => (err as Error).message === 'PROVIDER_NOT_CONFIGURED',
  )
  assert.throws(
    () => seedanceVideoPlugin.validateRequest({ ...baseRequest, prompt: '  ' }),
    (err: unknown) => (err as Error).message === 'INVALID_REQUEST',
  )
  assert.throws(
    () => seedanceVideoPlugin.validateRequest({ ...baseRequest, modality: 'image' }),
    (err: unknown) => (err as Error).message === 'INVALID_REQUEST',
  )
})

test('submit maps normalized aspectRatio/audio aliases to provider ratio/generate_audio', async () => {
  const { context, calls } = createContext(() => jsonResponse(200, { id: 'cgt-alias' }))
  const request: MediaRequest = {
    ...baseRequest,
    extra: { aspectRatio: '9:16', audio: true },
  }
  await seedanceVideoPlugin.submit(request, baseConfig, context)
  const body = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>
  assert.equal(body['ratio'], '9:16')
  assert.equal(body['generate_audio'], true)
  assert.equal('aspectRatio' in body, false)
  assert.equal('audio' in body, false)
})

test('submit keeps explicit provider keys winning over normalized aliases', async () => {
  const { context, calls } = createContext(() => jsonResponse(200, { id: 'cgt-explicit' }))
  const request: MediaRequest = {
    ...baseRequest,
    extra: { ratio: '16:9', aspectRatio: '9:16', generate_audio: false, audio: true },
  }
  await seedanceVideoPlugin.submit(request, baseConfig, context)
  const body = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>
  assert.equal(body['ratio'], '16:9')
  assert.equal(body['generate_audio'], false)
})
