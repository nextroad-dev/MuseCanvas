import sharp from 'sharp'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MASK_INPUT_ROLE, MAX_MASK_BYTES } from '@musecanvas/contracts'
import {
  LEGACY_OPENAI_IMAGE_PLUGIN_VERSION,
  OPENAI_IMAGE_PLUGIN_ID,
  OPENAI_IMAGE_PLUGIN_VERSION,
  OPENAI_IMAGE_SUPPORTED_MODELS,
  createEditMask,
  globalProviderRegistry,
  legacyOpenAiImageManifest,
  legacyOpenAiImagePlugin,
  openAiImageManifest,
  openAiImagePlugin,
  NormalizedProviderError,
  type MediaInputImage,
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
  // Only the active plugin accepts a separate alpha mask part, and only on the
  // model whose edit endpoint has one.
  assert.equal(openAiImageManifest.models?.find(m => m.id === 'gpt-image-2')?.supportsMask, true)
  assert.equal(openAiImageManifest.models?.find(m => m.id === 'dall-e-3')?.supportsMask, undefined)
  assert.equal(legacyOpenAiImageManifest.models?.find(m => m.id === 'gpt-image-2')?.supportsMask, undefined)
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
  // Regression guard: an edit without a mask must not grow a mask part, and the
  // reference image must still be the only `image[]` part.
  assert.equal(capturedForm.get('mask'), null)
  assert.equal((capturedForm.get('image[]') as File).name, 'reference-1.png')
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
    // `1792x1024` used to be rejected here as a dall-e-3-only size. It is now
    // legal for gpt-image-2, whose contract declares a custom-size band (edges on
    // a 16-pixel grid, 655,360–8,294,400 px, at most 3:1) that this value
    // satisfies — the vendor accepts it, so refusing it would be the plugin
    // inventing a limit. What must still fail is a value that breaks that band,
    // or any custom value on a model that declares a fixed list.
    { ...base, size: '1791x1024' }, // width off the 16-pixel grid
    { ...base, size: '3840x1024' }, // 3.75:1, above the model's 3:1 limit
    { ...base, vendorModelId: 'gpt-image-1.5', size: '2048x2048' }, // fixed-size model
    { ...base, vendorModelId: 'dall-e-3', size: '1536x1024' }, // not in dall-e-3's list
    { ...base, quality: 'max' }, // `max` exists only on the 2.5 models
    { ...base, quality: 'xhigh' },
    { ...base, vendorModelId: 'dall-e-3', size: '1024x1024', count: 2 }, // exceeds dall-e-3 batch of 1
    { ...base, count: 5 }, // exceeds gpt-image-2 batch of 4
    { ...base, quality: 'ultra' },
    { ...base, vendorModelId: 'dall-e-3', size: '1024x1024', quality: 'low' },
    { ...base, parameters: { background: 'transparent', output_format: 'jpeg' } }, // needs alpha
    {
      ...base,
      inputImages: Array.from({ length: 33 }, () => ({ data: mockPng, mimeType: 'image/png' as const })),
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

/* -------------------------------------------------------------------------
 * Region-select edits: the alpha mask
 * ------------------------------------------------------------------------- */

/** A real 1024x1024 PNG that only has a structural header (see `mockPng`). */
const BASE_IMAGE: MediaInputImage = { data: mockPng, mimeType: 'image/png', width: 1024, height: 1024 }

/** A real, decodable alpha mask rasterised by the shipped generator. */
async function realMask(width = 1024, height = 1024): Promise<Buffer> {
  return createEditMask({
    imageWidth: width,
    imageHeight: height,
    selection: { x: 4, y: 4, width: width - 8, height: height - 8 },
  })
}

function editRequest(
  inputImages: MediaInputImage[],
  vendorModelId = 'gpt-image-2',
): MediaRequest {
  return {
    modality: 'image',
    vendorModelId,
    prompt: 'Remove the scaffold',
    size: '1024x1024',
    count: 1,
    inputImages,
  }
}

function capturingFetch(): { fetchImpl: typeof globalThis.fetch; form: () => FormData | undefined } {
  let captured: FormData | undefined
  return {
    form: () => captured,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init?.body instanceof FormData ? (init.body as FormData) : undefined
      return new Response(JSON.stringify({ data: [{ b64_json: mockPng.toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch,
  }
}

test('an edit mask is forwarded as its own part and kept out of image[]', async () => {
  const cfg = config()
  const capture = capturingFetch()
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, capture.fetchImpl)
  const mask = await realMask()

  const result = await openAiImagePlugin.submit(
    editRequest([BASE_IMAGE, { data: mask, mimeType: 'image/png', width: 1024, height: 1024, sizeBytes: mask.length, role: MASK_INPUT_ROLE }]),
    cfg,
    ctx,
  )
  assert.equal(result.status, 'succeeded')
  const form = capture.form()
  assert.ok(form instanceof FormData)
  const keys = [...form.keys()]
  // What the mask slice owns: exactly one `mask` part, `image[]` free of it, and
  // the mask appended after the images rather than replacing one.
  assert.equal(keys.filter(key => key === 'image[]').length, 1)
  assert.equal(keys[keys.length - 1], 'mask')

  const maskParts = form.getAll('mask')
  assert.equal(maskParts.length, 1, 'the mask is appended exactly once')
  const maskPart = maskParts[0] as File
  assert.ok(maskPart instanceof Blob)
  assert.equal(maskPart.name, 'mask.png')
  assert.equal(maskPart.type, 'image/png')
  assert.equal(Buffer.from(await maskPart.arrayBuffer()).equals(mask), true)

  const imageParts = form.getAll('image[]')
  assert.equal(imageParts.length, 1, 'the mask must not be sent as a picture the model sees')
  assert.equal(Buffer.from(await (imageParts[0] as Blob).arrayBuffer()).equals(mockPng), true)
})

test('a mask alongside several reference images stays out of the image[] sequence', async () => {
  const cfg = config()
  const capture = capturingFetch()
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, capture.fetchImpl)
  const mask = await realMask(64, 64)

  const result = await openAiImagePlugin.submit(
    editRequest([
      BASE_IMAGE,
      { data: mask, mimeType: 'image/png', width: 1024, height: 1024, role: MASK_INPUT_ROLE },
      { data: mockPng, mimeType: 'image/png', width: 1024, height: 1024, role: 'style' },
    ]),
    cfg,
    ctx,
  )
  assert.equal(result.status, 'succeeded')
  const form = capture.form()!
  const keys = [...form.keys()]
  assert.deepEqual(
    keys.filter(key => key === 'image[]'),
    ['image[]', 'image[]'],
    'both references, and only them, go to image[]',
  )
  assert.equal((form.getAll('image[]')[1] as File).name, 'reference-2.png')
  assert.equal(form.getAll('mask').length, 1)
  assert.equal(keys[keys.length - 1], 'mask')
})

test('every bad mask is rejected before the network, with a mask-specific message', async () => {
  const cfg = config()
  const mask = await realMask()
  const maskInput = (overrides: Partial<MediaInputImage> = {}): MediaInputImage => ({
    data: mask,
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    role: MASK_INPUT_ROLE,
    ...overrides,
  })
  let fetchCalls = 0
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, (async () => {
    fetchCalls++
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch)

  const cases: Array<{ inputs: MediaInputImage[]; fragment: string }> = [
    { inputs: [BASE_IMAGE, maskInput(), maskInput()], fragment: 'at most one mask' },
    { inputs: [BASE_IMAGE, maskInput({ mimeType: 'image/jpeg' })], fragment: 'must be a PNG' },
    { inputs: [maskInput()], fragment: 'no base image' },
    { inputs: [BASE_IMAGE, maskInput({ width: 1280, height: 720 })], fragment: 'match the base image dimensions exactly' },
    { inputs: [BASE_IMAGE, maskInput({ width: undefined, height: undefined })], fragment: 'must both declare width and height' },
    { inputs: [{ ...BASE_IMAGE, width: undefined, height: undefined }, maskInput()], fragment: 'must both declare width and height' },
    { inputs: [BASE_IMAGE, maskInput({ sizeBytes: MAX_MASK_BYTES + 1 })], fragment: 'exceeds the vendor limit' },
  ]
  for (const { inputs, fragment } of cases) {
    await assert.rejects(
      () => openAiImagePlugin.submit(editRequest(inputs), cfg, ctx),
      (err: unknown) => {
        assert.ok(err instanceof NormalizedProviderError)
        assert.equal(err.diagnostic.code, 'INVALID_REQUEST')
        assert.ok(
          err.diagnostic.detail.includes(fragment),
          `expected '${fragment}' in '${err.diagnostic.detail}'`,
        )
        assert.ok(
          err.diagnostic.detail.toLowerCase().includes('mask'),
          `a mask failure must name the mask, got '${err.diagnostic.detail}'`,
        )
        assert.ok(
          !err.diagnostic.detail.startsWith('Invalid input image'),
          'a bad mask must not be reported as an invalid input image',
        )
        return true
      },
      `expected rejection mentioning '${fragment}'`,
    )
  }
  assert.equal(fetchCalls, 0, 'mask validation must reject before any network call')
})

test('dall-e-3 still rejects a mask alongside its other inputs', async () => {
  const cfg = config()
  const mask = await realMask()
  let fetchCalls = 0
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, (async () => {
    fetchCalls++
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch)
  await assert.rejects(
    () =>
      openAiImagePlugin.submit(
        editRequest(
          [BASE_IMAGE, { data: mask, mimeType: 'image/png', width: 1024, height: 1024, role: MASK_INPUT_ROLE }],
          'dall-e-3',
        ),
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

test('a mask is never run through the generic input-image dimension rules', async () => {
  // The mask's own bytes are far below this package's minimum *input image*
  // size, which is exactly the rule it must not be judged by: the vendor treats
  // it as a control channel, and the declared dimensions are what has to line up.
  const cfg = config()
  const capture = capturingFetch()
  const ctx = contextFor(OPENAI_IMAGE_PLUGIN_VERSION, cfg, capture.fetchImpl)
  const mask = await realMask(20, 20)

  const result = await openAiImagePlugin.submit(
    editRequest([BASE_IMAGE, { data: mask, mimeType: 'image/png', width: 1024, height: 1024, role: MASK_INPUT_ROLE }]),
    cfg,
    ctx,
  )
  assert.equal(result.status, 'succeeded')
  const form = capture.form()!
  assert.equal(form.getAll('mask').length, 1)
  assert.equal(form.getAll('image[]').length, 1)
})
