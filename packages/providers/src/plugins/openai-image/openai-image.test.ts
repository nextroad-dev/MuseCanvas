import sharp from 'sharp'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LEGACY_OPENAI_IMAGE_PLUGIN_VERSION,
  OPENAI_IMAGE_PLUGIN_ID,
  OPENAI_IMAGE_PLUGIN_VERSION,
  OPENAI_IMAGE_SUPPORTED_MODELS,
  globalProviderRegistry,
  legacyOpenAiImageManifest,
  legacyOpenAiImagePlugin,
  openAiImageManifest,
  openAiImagePlugin,
  NormalizedProviderError,
  type MediaRequest,
  type ProviderConfig,
} from '../../index'

const mockPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x00, // 1024
  0x00, 0x00, 0x04, 0x00, // 1024
  0x08, 0x06, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
])

function config(): ProviderConfig {
  return {
    baseUrl: 'https://api.openai.com',
    credential: { schema: 'legacy-api-key-v1', apiKey: 'sk-mock-key-1234567890' },
  }
}

function contextFor(
  version: string,
  cfg: ProviderConfig,
  fetchImpl: typeof globalThis.fetch,
  pluginId = OPENAI_IMAGE_PLUGIN_ID,
) {
  return globalProviderRegistry.createExecutionContext(pluginId, version, { config: cfg, fetchImpl })
}

function jsonFetch(body: unknown, status = 200) {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch
}

test('registry exposes both openai-image@1.1.0 and legacy openai-image@1.0.0', () => {
  assert.equal(OPENAI_IMAGE_PLUGIN_VERSION, '1.1.0')
  assert.equal(LEGACY_OPENAI_IMAGE_PLUGIN_VERSION, '1.0.0')
  assert.equal(openAiImageManifest.version, '1.1.0')
  assert.equal(legacyOpenAiImageManifest.version, '1.0.0')
  assert.equal(openAiImageManifest.models?.find(m => m.id === 'gpt-image-2')?.maxInputImages, 4)
  assert.equal(openAiImageManifest.models?.find(m => m.id === 'dall-e-3')?.maxInputImages, 0)
  assert.equal(legacyOpenAiImageManifest.models?.find(m => m.id === 'gpt-image-2')?.maxInputImages, undefined)
  assert.ok(OPENAI_IMAGE_SUPPORTED_MODELS.includes('gpt-image-2'))
  for (const version of [OPENAI_IMAGE_PLUGIN_VERSION, LEGACY_OPENAI_IMAGE_PLUGIN_VERSION]) {
    assert.equal(globalProviderRegistry.has(OPENAI_IMAGE_PLUGIN_ID, version), true)
    const plugin = globalProviderRegistry.get(OPENAI_IMAGE_PLUGIN_ID, version)
    assert.equal(plugin.manifest.id, OPENAI_IMAGE_PLUGIN_ID)
    assert.equal(plugin.manifest.version, version)
  }
  assert.notEqual(
    globalProviderRegistry.get(OPENAI_IMAGE_PLUGIN_ID, '1.1.0'),
    globalProviderRegistry.get(OPENAI_IMAGE_PLUGIN_ID, '1.0.0'),
  )
})

test('submit maps generation requests to the generations endpoint body', async () => {
  let capturedUrl = ''
  let capturedBody = ''
  const rendered = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: { r: 12, g: 34, b: 56 } },
  }).png().toBuffer()
  const cfg = config()
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url)
    capturedBody = String(init?.body || '')
    return new Response(JSON.stringify({ data: [{ b64_json: rendered.toString('base64') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch)

  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: 'gpt-image-2',
    prompt: 'A futuristic city in watercolor',
    size: '1024x1024',
    quality: 'high',
    count: 1,
  }
  const result = await openAiImagePlugin.submit(request, cfg, ctx)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.outputs?.length, 1)
  assert.equal(capturedUrl, 'https://api.openai.com/v1/images/generations')
  assert.deepEqual(JSON.parse(capturedBody), {
    model: 'gpt-image-2',
    prompt: 'A futuristic city in watercolor',
    size: '1024x1024',
    quality: 'high',
    output_format: 'png',
    n: 1,
  })
  const output = result.outputs![0]
  assert.equal(output.b64Json, rendered.toString('base64'))
  assert.equal(output.url, undefined)

  const opened = await openAiImagePlugin.openOutput(output, cfg, ctx)
  assert.equal(opened.mimeType, 'image/png')
  assert.equal(opened.width, 1024)
  assert.equal(opened.height, 1024)
  assert.equal(opened.data.equals(rendered), true)
})

test('submit maps reference images to the edits multipart body', async () => {
  let capturedUrl = ''
  let capturedForm: FormData | undefined
  const cfg = config()
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url)
    capturedForm = init?.body instanceof FormData ? (init.body as FormData) : undefined
    return new Response(JSON.stringify({ data: [{ b64_json: mockPng.toString('base64') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch)

  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: 'gpt-image-2',
    prompt: 'Add trees to the background',
    size: '1024x1024',
    count: 1,
    inputImages: [{ data: mockPng, mimeType: 'image/png', width: 1024, height: 1024 }],
  }
  const result = await openAiImagePlugin.submit(request, cfg, ctx)
  assert.equal(result.status, 'succeeded')
  assert.equal(capturedUrl, 'https://api.openai.com/v1/images/edits')
  assert.ok(capturedForm instanceof FormData)
  assert.equal(capturedForm.get('model'), 'gpt-image-2')
  assert.equal(capturedForm.get('prompt'), 'Add trees to the background')
  assert.equal(capturedForm.get('size'), '1024x1024')
  assert.equal(capturedForm.get('output_format'), 'png')
  assert.equal(capturedForm.get('n'), '1')
  const sentImages = capturedForm.getAll('image[]')
  assert.equal(sentImages.length, 1)
  assert.ok(sentImages[0] instanceof Blob)
  assert.equal((sentImages[0] as Blob).type, 'image/png')
})

test('validateRequest rejects bad modality/prompt/model/size/count/quality/inputs before network', async () => {
  const cfg = config()
  let fetchCalls = 0
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, (async () => {
    fetchCalls++
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch)

  const base: MediaRequest = {
    modality: 'image',
    vendorModelId: 'gpt-image-2',
    prompt: 'ok',
    size: '1024x1024',
    count: 1,
  }
  const cases: MediaRequest[] = [
    { ...base, modality: 'video' as MediaRequest['modality'] },
    { ...base, prompt: '   ' },
    { ...base, vendorModelId: 'unknown-model' },
    { ...base, size: '9999x9999' },
    { ...base, size: '1792x1024' }, // dall-e-3-only size
    { ...base, vendorModelId: 'dall-e-3', size: '1024x1024', count: 2 }, // exceeds dall-e-3 batch of 1
    { ...base, count: 5 }, // exceeds gpt-image-2 batch of 4
    { ...base, quality: 'ultra' },
    { ...base, vendorModelId: 'dall-e-3', size: '1024x1024', quality: 'low' },
    {
      ...base,
      inputImages: [
        { data: mockPng, mimeType: 'image/png' },
        { data: mockPng, mimeType: 'image/png' },
        { data: mockPng, mimeType: 'image/png' },
        { data: mockPng, mimeType: 'image/png' },
        { data: mockPng, mimeType: 'image/png' },
      ],
    },
    { ...base, inputImages: [{ data: mockPng, mimeType: 'image/gif' as unknown as 'image/png' }] },
  ]
  for (const request of cases) {
    await assert.rejects(
      () => openAiImagePlugin.submit(request, cfg, ctx),
      (err: unknown) => {
        assert.ok(err instanceof NormalizedProviderError)
        assert.equal(err.diagnostic.code, 'INVALID_REQUEST')
        return true
      },
      `expected INVALID_REQUEST for ${JSON.stringify({ modality: request.modality, vendorModelId: request.vendorModelId, size: request.size, count: request.count, quality: request.quality, inputs: request.inputImages?.length })}`,
    )
  }
  assert.equal(fetchCalls, 0, 'validation must reject before any network call')
})

test('transient HTTP and transport errors throw normalized errors', async () => {
  const cfg = config()
  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: 'gpt-image-2',
    prompt: 'ok',
    size: '1024x1024',
    count: 1,
  }
  for (const status of [429, 500, 503]) {
    const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, jsonFetch({ error: 'busy' }, status))
    await assert.rejects(() => openAiImagePlugin.submit(request, cfg, ctx), (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'PROVIDER_TEMPORARY_ERROR')
      assert.equal(err.diagnostic.status, status)
      return true
    })
  }

  const transportCtx = contextFor(
    OPENAI_IMAGE_PLUGIN_VERSION,
    cfg,
    (async () => {
      throw new TypeError('fetch failed')
    }) as typeof globalThis.fetch,
  )
  await assert.rejects(() => openAiImagePlugin.submit(request, cfg, transportCtx), (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'PROVIDER_TEMPORARY_ERROR')
    return true
  })

  const timeoutCtx = contextFor(
    OPENAI_IMAGE_PLUGIN_VERSION,
    cfg,
    (async () => {
      const abort = new Error('aborted')
      abort.name = 'AbortError'
      throw abort
    }) as typeof globalThis.fetch,
  )
  await assert.rejects(() => openAiImagePlugin.submit(request, cfg, timeoutCtx), (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'PROVIDER_TIMEOUT')
    return true
  })
})

test('deterministic 4xx returns terminal failed with PROVIDER_REJECTED', async () => {
  const cfg = config()
  const ctx = contextFor(
    OPENAI_IMAGE_PLUGIN_VERSION,
    cfg,
    (async () => new Response('bad request detail', { status: 400, statusText: 'Bad Request' })) as typeof globalThis.fetch,
  )
  const result = await openAiImagePlugin.submit(
    { modality: 'image', vendorModelId: 'gpt-image-2', prompt: 'ok', size: '1024x1024', count: 1 },
    cfg,
    ctx,
  )
  assert.equal(result.status, 'failed')
  assert.equal(result.error?.code, 'PROVIDER_REJECTED')
  assert.equal(result.error?.status, 400)
  assert.ok(result.error?.detail.includes('bad request detail'))
})

test('outputs keep exactly one of url/b64Json with HTTPS URLs; unusable payloads fail', async () => {
  const cfg = config()
  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: 'gpt-image-2',
    prompt: 'ok',
    size: '1024x1024',
    count: 2,
  }
  const goodB64 = mockPng.toString('base64')
  const ctx = contextFor(
    OPENAI_IMAGE_PLUGIN_VERSION,
    cfg,
    jsonFetch({
      data: [
        { url: 'https://cdn.example.com/a.png', b64_json: goodB64 }, // both set: dropped
        {}, // neither set: dropped
        { url: 'http://cdn.example.com/b.png' }, // insecure: dropped
        { url: 'https://cdn.example.com/c.png' },
        { b64_json: goodB64 },
      ],
    }),
  )
  const result = await openAiImagePlugin.submit(request, cfg, ctx)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.outputs?.length, 2)
  assert.equal(result.outputs![0].url, 'https://cdn.example.com/c.png')
  assert.equal(result.outputs![0].b64Json, undefined)
  assert.equal(result.outputs![1].b64Json, goodB64)
  assert.equal(result.outputs![1].url, undefined)

  const emptyCtx = contextFor(
    OPENAI_IMAGE_PLUGIN_VERSION,
    cfg,
    jsonFetch({ data: [{ url: 'http://cdn.example.com/b.png' }, {}] }),
  )
  const empty = await openAiImagePlugin.submit(request, cfg, emptyCtx)
  assert.equal(empty.status, 'failed')
  assert.equal(empty.error?.code, 'PROVIDER_EMPTY_RESULT')
})

test('openOutput rejects ambiguous, insecure, and non-image descriptors', async () => {
  const cfg = config()
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, jsonFetch({}))
  const both = { index: 0, mimeType: 'image/png', url: 'https://cdn.example.com/a.png', b64Json: mockPng.toString('base64') }
  await assert.rejects(() => openAiImagePlugin.openOutput(both, cfg, ctx), (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'INVALID_REQUEST')
    assert.ok(err.diagnostic.detail.includes('exactly one'))
    return true
  })
  const neither = { index: 0, mimeType: 'image/png' }
  await assert.rejects(() => openAiImagePlugin.openOutput(neither, cfg, ctx), (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'INVALID_REQUEST')
    assert.ok(err.diagnostic.detail.includes('exactly one'))
    return true
  })
  const insecure = { index: 0, mimeType: 'image/png', url: 'http://cdn.example.com/a.png' }
  await assert.rejects(() => openAiImagePlugin.openOutput(insecure, cfg, ctx), (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'UNSAFE_URL')
    assert.ok(err.diagnostic.detail.includes('HTTPS'))
    return true
  })
  const nonImage = { index: 0, mimeType: 'text/plain', b64Json: Buffer.from('x').toString('base64') }
  await assert.rejects(() => openAiImagePlugin.openOutput(nonImage, cfg, ctx), (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'INVALID_REQUEST')
    assert.ok(err.diagnostic.detail.includes('PNG/JPEG'))
    return true
  })

  const lyingCtx = contextFor(
    OPENAI_IMAGE_PLUGIN_VERSION,
    cfg,
    (async () =>
      new Response('not an image', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof globalThis.fetch,
  )
  await assert.rejects(
    () => openAiImagePlugin.openOutput({ index: 0, mimeType: 'image/png', url: 'https://api.openai.com/mock-image.png' }, cfg, lyingCtx),
    (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'OUTPUT_READ_FAILED')
      return true
    },
  )
})

test('legacy 1.0.0 plugin keeps pinned-revision behavior', async () => {
  const cfg = config()
  const ctx = contextFor('1.0.0', cfg, jsonFetch({ data: [{ b64_json: mockPng.toString('base64') }] }))
  const result = await legacyOpenAiImagePlugin.submit(
    { modality: 'image', vendorModelId: 'gpt-image-2', prompt: 'ok', size: '1024x1024', count: 1 },
    cfg,
    ctx,
  )
  assert.equal(result.status, 'succeeded')

  const rejectedCtx = contextFor(
    '1.0.0',
    cfg,
    (async () => new Response('nope', { status: 400, statusText: 'Bad Request' })) as typeof globalThis.fetch,
  )
  const rejected = await legacyOpenAiImagePlugin.submit(
    { modality: 'image', vendorModelId: 'gpt-image-2', prompt: 'ok', size: '1024x1024', count: 1 },
    cfg,
    rejectedCtx,
  )
  assert.equal(rejected.status, 'failed')
  assert.equal(rejected.error?.code, 'PROVIDER_REJECTED')
})

test('dall-e-3 uses b64_json response format without GPT-only fields', async () => {
  let capturedBody = ''
  const cfg = config()
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, (async (url: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body || '')
    assert.equal(String(url), 'https://api.openai.com/v1/images/generations')
    return new Response(JSON.stringify({ data: [{ b64_json: mockPng.toString('base64') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch)

  const result = await openAiImagePlugin.submit(
    { modality: 'image', vendorModelId: 'dall-e-3', prompt: 'A calm lake', size: '1024x1024', quality: 'hd', count: 1 },
    cfg,
    ctx,
  )
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(JSON.parse(capturedBody), {
    model: 'dall-e-3',
    prompt: 'A calm lake',
    size: '1024x1024',
    quality: 'hd',
    response_format: 'b64_json',
    n: 1,
  })
  assert.equal(result.outputs?.length, 1)
  assert.equal(result.outputs![0].b64Json, mockPng.toString('base64'))
  assert.equal(result.outputs![0].url, undefined)
})

test('dall-e-3 rejects reference images before network', async () => {
  const cfg = config()
  let fetchCalls = 0
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, (async () => {
    fetchCalls++
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch)
  await assert.rejects(
    () =>
      openAiImagePlugin.submit(
        {
          modality: 'image',
          vendorModelId: 'dall-e-3',
          prompt: 'Edit this',
          size: '1024x1024',
          count: 1,
          inputImages: [{ data: mockPng, mimeType: 'image/png' }],
        },
        cfg,
        ctx,
      ),
    (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'INVALID_REQUEST')
      assert.ok(err.diagnostic.detail.includes('dall-e-3'))
      return true
    },
  )
  assert.equal(fetchCalls, 0)
})

test('active validateConfig pins api.openai.com and rejects compatible endpoints', () => {
  openAiImagePlugin.validateConfig(config())
  openAiImagePlugin.validateConfig({ credential: { schema: 'legacy-api-key-v1', apiKey: 'sk-x' } })
  for (const baseUrl of ['https://proxy.example.com/v1', 'http://api.openai.com', 'https://api.openai.com.evil.example.com', 'not a url']) {
    assert.throws(
      () => openAiImagePlugin.validateConfig({ ...config(), baseUrl }),
      (err: unknown) => {
        assert.ok(err instanceof NormalizedProviderError)
        assert.equal(err.diagnostic.code, 'INVALID_CONFIG')
        return true
      },
      `expected INVALID_CONFIG for baseUrl ${baseUrl}`,
    )
  }
})

test('authenticated calls do not follow redirects off the endpoint host', async () => {
  const cfg = config()
  let fetchCalls = 0
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, (async () => {
    fetchCalls++
    return new Response(null, { status: 302, headers: { location: 'https://cdn.evil.example.com/x.png' } })
  }) as typeof globalThis.fetch)
  await assert.rejects(
    () =>
      openAiImagePlugin.submit(
        { modality: 'image', vendorModelId: 'gpt-image-2', prompt: 'ok', size: '1024x1024', count: 1 },
        cfg,
        ctx,
      ),
    (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'UNSAFE_URL')
      return true
    },
  )
  assert.equal(fetchCalls, 1, 'redirect target must be rejected before a second fetch')
})

test('openOutput verifies detected bytes and rejects spoofed MIME', async () => {
  const cfg = config()
  const jpeg = await sharp({
    create: { width: 200, height: 300, channels: 3, background: { r: 200, g: 100, b: 50 } },
  }).jpeg().toBuffer()
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, jsonFetch({}))

  const legit = await openAiImagePlugin.openOutput(
    { index: 0, mimeType: 'image/jpeg', b64Json: jpeg.toString('base64') },
    cfg,
    ctx,
  )
  assert.equal(legit.mimeType, 'image/jpeg')
  assert.equal(legit.width, 200)
  assert.equal(legit.height, 300)

  await assert.rejects(
    () =>
      openAiImagePlugin.openOutput(
        { index: 0, mimeType: 'image/png', b64Json: jpeg.toString('base64') },
        cfg,
        ctx,
      ),
    (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'OUTPUT_READ_FAILED')
      assert.ok(err.diagnostic.detail.includes('MIME mismatch'))
      return true
    },
  )

  const lyingCtx = contextFor(
    OPENAI_IMAGE_PLUGIN_VERSION,
    cfg,
    (async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { 'content-type': 'image/png' } })) as typeof globalThis.fetch,
  )
  await assert.rejects(
    () =>
      openAiImagePlugin.openOutput(
        { index: 0, mimeType: 'image/png', url: 'https://api.openai.com/spoofed.png' },
        cfg,
        lyingCtx,
      ),
    (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'OUTPUT_READ_FAILED')
      assert.ok(err.diagnostic.detail.includes('MIME mismatch'))
      return true
    },
  )
})

test('probe self-validates config and never fetches custom hosts', async () => {
  const cfg = { ...config(), baseUrl: 'https://proxy.example.com/v1' }
  let fetchCalls = 0
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, config(), (async () => {
    fetchCalls++
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch)
  await assert.rejects(() => openAiImagePlugin.probe(cfg, ctx), (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'INVALID_CONFIG')
    return true
  })
  assert.equal(fetchCalls, 0)
})
