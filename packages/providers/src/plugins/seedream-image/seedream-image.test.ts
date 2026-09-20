import sharp from 'sharp'
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateModelCapabilities, validateParameterValue } from '@musecanvas/contracts'
import type {
  ImageSizeParameterDescriptor,
  ModelCapabilities,
} from '@musecanvas/contracts'
import {
  LEGACY_SEEDREAM_IMAGE_PLUGIN_VERSION,
  SEEDREAM_IMAGE_PLUGIN_ID,
  SEEDREAM_IMAGE_PLUGIN_VERSION,
  SEEDREAM_IMAGE_SUPPORTED_MODELS,
  globalProviderRegistry,
  legacySeedreamImageManifest,
  legacySeedreamImagePlugin,
  normalizeSeedreamSize,
  seedreamImageManifest,
  seedreamImagePlugin,
  NormalizedProviderError,
  validatePluginManifest,
  type MediaModelDeclaration,
  type MediaProviderManifest,
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

async function realPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } },
  }).png().toBuffer()
}

async function realJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  }).jpeg().toBuffer()
}

function config(): ProviderConfig {
  return {
    credential: { schema: 'legacy-api-key-v1', apiKey: 'ark-mock-key-123' },
  }
}

function contextFor(version: string, cfg: ProviderConfig, fetchImpl: typeof globalThis.fetch) {
  return globalProviderRegistry.createExecutionContext(SEEDREAM_IMAGE_PLUGIN_ID, version, {
    config: cfg,
    fetchImpl,
  })
}

function jsonFetch(body: unknown, status = 200) {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch
}

test('registry exposes both seedream-image@1.1.0 and legacy seedream-image@1.0.0', () => {
  assert.equal(SEEDREAM_IMAGE_PLUGIN_VERSION, '1.1.0')
  assert.equal(LEGACY_SEEDREAM_IMAGE_PLUGIN_VERSION, '1.0.0')
  assert.equal(seedreamImageManifest.version, '1.1.0')
  assert.equal(legacySeedreamImageManifest.version, '1.0.0')
  assert.equal(seedreamImageManifest.models?.find(m => m.id === 'doubao-seedream-4-0-250828')?.maxInputImages, 4)
  assert.equal(seedreamImageManifest.models?.find(m => m.id === 'doubao-seedream-4-5-251128')?.maxInputImages, 4)
  assert.equal(legacySeedreamImageManifest.models?.find(m => m.id === 'doubao-seedream-4-0-250828')?.maxInputImages, undefined)
  assert.deepEqual([...SEEDREAM_IMAGE_SUPPORTED_MODELS], ['doubao-seedream-4-0-250828', 'doubao-seedream-4-5-251128'])
  for (const version of [SEEDREAM_IMAGE_PLUGIN_VERSION, LEGACY_SEEDREAM_IMAGE_PLUGIN_VERSION]) {
    assert.equal(globalProviderRegistry.has(SEEDREAM_IMAGE_PLUGIN_ID, version), true)
    const plugin = globalProviderRegistry.get(SEEDREAM_IMAGE_PLUGIN_ID, version)
    assert.equal(plugin.manifest.id, SEEDREAM_IMAGE_PLUGIN_ID)
    assert.equal(plugin.manifest.version, version)
  }
  assert.notEqual(
    globalProviderRegistry.get(SEEDREAM_IMAGE_PLUGIN_ID, '1.1.0'),
    globalProviderRegistry.get(SEEDREAM_IMAGE_PLUGIN_ID, '1.0.0'),
  )
})

test('submit maps sequential requests and downloads remote outputs', async () => {
  let capturedUrl = ''
  let capturedBody: Record<string, unknown> = {}
  const cfg = config()
  const rendered = await realPng(1024, 1024)
  const ctx = contextFor(
    SEEDREAM_IMAGE_PLUGIN_VERSION,
    cfg,
    (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes('/api/v3/images/generations')) {
        capturedUrl = urlStr
        capturedBody = JSON.parse(String(init?.body || '{}'))
        return new Response(
          JSON.stringify({ data: [{ url: 'https://ark.cn-beijing.volces.com/mock-image.png' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (urlStr.includes('/mock-image.png')) {
        return new Response(new Uint8Array(rendered), { status: 200, headers: { 'content-type': 'image/png' } })
      }
      throw new Error(`Unexpected url: ${urlStr}`)
    }) as typeof globalThis.fetch,
  )

  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: 'doubao-seedream-4-5-251128',
    prompt: 'Fantasy landscape',
    size: '2048x2048',
    count: 2,
    watermark: false,
  }
  const result = await seedreamImagePlugin.submit(request, cfg, ctx)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.outputs?.length, 1)
  assert.equal(capturedUrl, 'https://ark.cn-beijing.volces.com/api/v3/images/generations')
  assert.deepEqual(capturedBody, {
    model: 'doubao-seedream-4-5-251128',
    prompt: 'Fantasy landscape',
    size: '2048x2048',
    response_format: 'url',
    watermark: false,
    stream: false,
    sequential_image_generation: 'auto',
    sequential_image_generation_options: { max_images: 2 },
  })
  assert.equal(result.outputs![0].url, 'https://ark.cn-beijing.volces.com/mock-image.png')
  assert.equal(result.outputs![0].b64Json, undefined)

  const output = await seedreamImagePlugin.openOutput(result.outputs![0], cfg, ctx)
  assert.equal(output.mimeType, 'image/png')
  assert.equal(output.width, 1024)
  assert.equal(output.height, 1024)
  assert.equal(output.data.equals(rendered), true)
})

test('submit maps single and multiple reference images to data-URL fields', async () => {
  const seen: Array<{ image: unknown; count: number }> = []
  const cfg = config()
  const ctx = contextFor(
    SEEDREAM_IMAGE_PLUGIN_VERSION,
    cfg,
    (async (_url: string | URL | Request, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      seen.push({ image: parsed.image, count: Number((parsed.sequential_image_generation_options as { max_images: number } | undefined)?.max_images ?? 1) })
      return new Response(JSON.stringify({ data: [{ b64_json: mockPng.toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch,
  )

  const single: MediaRequest = {
    modality: 'image',
    vendorModelId: 'doubao-seedream-4-0-250828',
    prompt: 'blend picture',
    size: '1024x1024',
    count: 1,
    watermark: false,
    inputImages: [{ data: mockPng, mimeType: 'image/png' }],
  }
  const singleResult = await seedreamImagePlugin.submit(single, cfg, ctx)
  assert.equal(singleResult.status, 'succeeded')
  assert.equal(typeof seen[0].image, 'string')
  assert.equal(String(seen[0].image).startsWith('data:image/png;base64,'), true)

  const multi: MediaRequest = {
    ...single,
    prompt: 'blend pictures',
    count: 2,
    inputImages: [
      { data: mockPng, mimeType: 'image/png' },
      { data: mockPng.toString('base64'), mimeType: 'image/png' },
    ],
  }
  const multiResult = await seedreamImagePlugin.submit(multi, cfg, ctx)
  assert.equal(multiResult.status, 'succeeded')
  assert.ok(Array.isArray(seen[1].image))
  assert.equal((seen[1].image as string[]).length, 2)
  assert.equal((seen[1].image as string[])[0].startsWith('data:image/png;base64,'), true)
})

test('validateRequest rejects bad modality/prompt/model/size/count/inputs before network', async () => {
  const cfg = config()
  let fetchCalls = 0
  const ctx = contextFor(
    SEEDREAM_IMAGE_PLUGIN_VERSION,
    cfg,
    (async () => {
      fetchCalls++
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch,
  )

  const base: MediaRequest = {
    modality: 'image',
    vendorModelId: 'doubao-seedream-4-5-251128',
    prompt: 'ok',
    size: '2048x2048',
    count: 1,
    watermark: false,
  }
  const cases: MediaRequest[] = [
    { ...base, modality: 'video' as MediaRequest['modality'] },
    { ...base, prompt: '' },
    { ...base, vendorModelId: 'doubao-seedream-9-9-999999' },
    { ...base, size: '1024x1024' }, // below 4.5 pixel floor
    { ...base, size: '2K' },
    { ...base, count: 0 },
    { ...base, count: 5 }, // exceeds batch of 4
    {
      ...base,
      vendorModelId: 'doubao-seedream-4-0-250828',
      size: '1024x1024',
      inputImages: Array.from({ length: 33 }, () => ({ data: mockPng, mimeType: 'image/png' as const })),
    },
    {
      ...base,
      vendorModelId: 'doubao-seedream-4-0-250828',
      size: '1024x1024',
      inputImages: [{ data: mockPng, mimeType: 'image/webp' as unknown as 'image/png' }],
    },
    {
      ...base,
      vendorModelId: 'doubao-seedream-4-0-250828',
      size: '1024x1024',
      inputImages: [{ data: Buffer.from('bad bytes'), mimeType: 'image/png' }],
    },
  ]
  for (const request of cases) {
    await assert.rejects(
      () => seedreamImagePlugin.submit(request, cfg, ctx),
      (err: unknown) => {
        assert.ok(err instanceof NormalizedProviderError)
        assert.equal(err.diagnostic.code, 'INVALID_REQUEST')
        return true
      },
      `expected INVALID_REQUEST for ${JSON.stringify({ vendorModelId: request.vendorModelId, size: request.size, count: request.count, inputs: request.inputImages?.length })}`,
    )
  }
  assert.equal(fetchCalls, 0, 'validation must reject before any network call')
})

test('seedream size rules stay pixel-based per model', () => {
  assert.equal(normalizeSeedreamSize('1024x1024', 'doubao-seedream-4-0-250828'), '1024x1024')
  assert.equal(normalizeSeedreamSize('2048x2048', 'doubao-seedream-4-5-251128'), '2048x2048')
  assert.equal(normalizeSeedreamSize('5504x3040', 'doubao-seedream-4-5-251128'), '5504x3040')
  assert.throws(() => normalizeSeedreamSize('1024x1024', 'doubao-seedream-4-5-251128'), /INVALID_IMAGE_SIZE/)
  assert.throws(() => normalizeSeedreamSize('2K', 'doubao-seedream-4-5-251128'), /INVALID_IMAGE_SIZE/)
})

const capabilityCases: Array<{
  id: string
  minPixels: number
  presetCount: number
  /** In-band but on no preset grid: must stay accepted. */
  unlistedLegalSize: string
  belowBandSize: string
}> = [
  {
    id: 'doubao-seedream-4-0-250828',
    minPixels: 1280 * 720,
    presetCount: 24,
    unlistedLegalSize: '1500x1000',
    belowBandSize: '800x800',
  },
  {
    id: 'doubao-seedream-4-5-251128',
    minPixels: 2560 * 1440,
    presetCount: 16,
    unlistedLegalSize: '2600x1500',
    belowBandSize: '1024x1024',
  },
]

function sizeDescriptorOf(model: MediaModelDeclaration): ImageSizeParameterDescriptor {
  return (model.capabilities as ModelCapabilities).parameters.find(
    parameter => parameter.type === 'image-size',
  ) as ImageSizeParameterDescriptor
}

function parameterNames(model: MediaModelDeclaration): string[] {
  return model.capabilities?.parameters.map(parameter => parameter.name) ?? []
}

test('active manifest declares one accepted contract per model, and no invented parameter', () => {
  const declared = new Map((seedreamImageManifest.models ?? []).map(model => [model.id, model]))
  assert.deepEqual([...declared.keys()], [...SEEDREAM_IMAGE_SUPPORTED_MODELS])

  for (const testCase of capabilityCases) {
    const model = declared.get(testCase.id) as MediaModelDeclaration
    const capabilities = model.capabilities as ModelCapabilities
    const probe = validateModelCapabilities({ ...capabilities, defaults: model.defaults })
    assert.ok(probe.ok, `${testCase.id} declaration rejected: ${JSON.stringify(probe.findings)}`)

    assert.equal(capabilities.declaredBy, 'plugin-manifest')
    assert.deepEqual(capabilities.modes, ['text_to_image', 'image_to_image'])
    // mask / inpainting / transparentBackground stay absent: unconfirmed, not false.
    assert.deepEqual(capabilities.flags, { textToImage: true, imageToImage: true, imageEdit: true })
    // `quality` is absent because this vendor accepts no quality token at all.
    assert.deepEqual(parameterNames(model), ['size', 'count', 'watermark'])
    assert.deepEqual(capabilities.inputSlots, [
      { role: 'reference_image', required: false, minCount: 0, maxCount: 4, allowedMediaKinds: ['image'], label: '参考图' },
    ])
    assert.deepEqual(model.defaults, { size: '2048x2048', count: 1, watermark: false })

    const size = sizeDescriptorOf(model)
    assert.equal(size.allowCustom, true)
    assert.deepEqual(size.constraints, {
      maxPixels: 4096 * 4096,
      maxAspectRatio: 16,
      minPixels: testCase.minPixels,
    })
    assert.equal(size.presets.length, testCase.presetCount)
    for (const preset of size.presets) {
      // A preset is a promise of legality against its own band.
      assert.deepEqual(validateParameterValue(size, preset.value), [], preset.value)
      assert.equal(normalizeSeedreamSize(preset.value, testCase.id), preset.value)
      assert.match(preset.label, /×/, preset.value)
    }

    assert.deepEqual(validateParameterValue(size, testCase.unlistedLegalSize), [])
    assert.notEqual(validateParameterValue(size, testCase.belowBandSize).length, 0)
  }
})

test('the shared descriptor set is composed once, not duplicated per model', () => {
  const [first, second] = seedreamImageManifest.models ?? []
  const [firstSize, firstCount, firstWatermark] = (first.capabilities as ModelCapabilities).parameters
  const [secondSize, secondCount, secondWatermark] = (second.capabilities as ModelCapabilities).parameters
  assert.equal(firstCount, secondCount, 'count is one declaration shared by both models')
  assert.equal(firstWatermark, secondWatermark, 'watermark is one declaration shared by both models')
  assert.notEqual(firstSize, secondSize, 'only the size band differs per model')
  assert.equal(first.capabilities?.inputSlots, second.capabilities?.inputSlots)
  // 4.5 offers the 2K and 4K grids; 4.0 is those same entries plus the 1K band.
  assert.deepEqual((firstSize as ImageSizeParameterDescriptor).presets.slice(8), (secondSize as ImageSizeParameterDescriptor).presets)
})

test('legacy 1.0.0 manifest stays thin so pinned revisions keep their permissive rules', () => {
  for (const model of legacySeedreamImageManifest.models ?? []) {
    assert.equal(model.capabilities, undefined)
    assert.equal(model.defaults, undefined)
    assert.equal(model.maxInputImages, undefined)
    assert.equal(model.maxBatchSize, 4)
  }
})

test('plugin-scan carries the declaration through instead of stripping it', () => {
  for (const manifest of [seedreamImageManifest, legacySeedreamImageManifest]) {
    const validated = validatePluginManifest(JSON.parse(JSON.stringify(manifest)))
    if (!validated.ok) {
      assert.fail(`manifest ${manifest.version} rejected: ${JSON.stringify(validated.findings)}`)
    }
    const sanitized = validated.manifest as MediaProviderManifest
    assert.deepEqual(
      sanitized.models?.map(model => parameterNames(model)),
      manifest === seedreamImageManifest
        ? [['size', 'count', 'watermark'], ['size', 'count', 'watermark']]
        : [[], []],
    )
    if (manifest === seedreamImageManifest) {
      for (const index of [0, 1]) {
        assert.deepEqual(
          sanitized.models?.[index]?.capabilities,
          (manifest.models?.[index] as MediaModelDeclaration).capabilities,
        )
        assert.deepEqual(sanitized.models?.[index]?.defaults, manifest.models?.[index]?.defaults)
      }
    }
  }
})

test('validateRequest answers from the declaration rather than a private table', () => {
  const invalidRequest = (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'INVALID_REQUEST')
    return true
  }
  const base: MediaRequest = {
    modality: 'image',
    vendorModelId: 'doubao-seedream-4-0-250828',
    prompt: 'ok',
    count: 1,
    watermark: false,
  }
  // Preset, custom-in-band and legacy width/height fields all read the same band.
  seedreamImagePlugin.validateRequest({ ...base, size: '1024x1024' })
  seedreamImagePlugin.validateRequest({ ...base, size: '1500x1000' })
  seedreamImagePlugin.validateRequest({ ...base, width: 1500, height: 1000 })
  seedreamImagePlugin.validateRequest({ ...base, count: 4 })
  assert.throws(() => seedreamImagePlugin.validateRequest({ ...base, size: '800x800' }), invalidRequest)
  assert.throws(() => seedreamImagePlugin.validateRequest({ ...base, width: 800, height: 800 }), invalidRequest)
  assert.throws(() => seedreamImagePlugin.validateRequest({ ...base, count: 5 }), invalidRequest)
  assert.throws(
    () => seedreamImagePlugin.validateRequest({ ...base, watermark: 'yes' as unknown as boolean }),
    invalidRequest,
  )
  // The floor is per model: 4.5 declares 2560x1440, 4.0 declares 1280x720.
  assert.throws(
    () => seedreamImagePlugin.validateRequest({ ...base, vendorModelId: 'doubao-seedream-4-5-251128', size: '1280x720' }),
    invalidRequest,
  )
  assert.throws(() => seedreamImagePlugin.validateRequest({ ...base, vendorModelId: 'doubao-seedream-9-9-999999' }), invalidRequest)
})

test('transient HTTP and transport errors throw normalized errors', async () => {
  const cfg = config()
  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: 'doubao-seedream-4-0-250828',
    prompt: 'ok',
    size: '1024x1024',
    count: 1,
    watermark: false,
  }
  for (const status of [429, 500, 503]) {
    const ctx = contextFor(SEEDREAM_IMAGE_PLUGIN_VERSION, cfg, jsonFetch({ error: 'busy' }, status))
    await assert.rejects(() => seedreamImagePlugin.submit(request, cfg, ctx), (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'PROVIDER_TEMPORARY_ERROR')
      assert.equal(err.diagnostic.status, status)
      return true
    })
  }

  const transportCtx = contextFor(
    SEEDREAM_IMAGE_PLUGIN_VERSION,
    cfg,
    (async () => {
      throw new TypeError('fetch failed')
    }) as typeof globalThis.fetch,
  )
  await assert.rejects(() => seedreamImagePlugin.submit(request, cfg, transportCtx), (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'PROVIDER_TEMPORARY_ERROR')
    return true
  })
})

test('deterministic 4xx returns terminal failed with PROVIDER_REJECTED', async () => {
  const cfg = config()
  const ctx = contextFor(
    SEEDREAM_IMAGE_PLUGIN_VERSION,
    cfg,
    (async () => new Response('content filtered', { status: 400, statusText: 'Bad Request' })) as typeof globalThis.fetch,
  )
  const result = await seedreamImagePlugin.submit(
    {
      modality: 'image',
      vendorModelId: 'doubao-seedream-4-0-250828',
      prompt: 'ok',
      size: '1024x1024',
      count: 1,
      watermark: false,
    },
    cfg,
    ctx,
  )
  assert.equal(result.status, 'failed')
  assert.equal(result.error?.code, 'PROVIDER_REJECTED')
  assert.equal(result.error?.status, 400)
})

test('outputs keep exactly one of url/b64Json with HTTPS URLs; failures stay terminal', async () => {
  const cfg = config()
  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: 'doubao-seedream-4-0-250828',
    prompt: 'ok',
    size: '1024x1024',
    count: 2,
    watermark: false,
  }
  const ctx = contextFor(
    SEEDREAM_IMAGE_PLUGIN_VERSION,
    cfg,
    jsonFetch({
      data: [
        { url: 'https://cdn.example.com/a.png', b64_json: mockPng.toString('base64') }, // both: dropped
        { error: { code: 'content_filtered' } }, // neither: dropped
        { url: 'http://cdn.example.com/b.png' }, // insecure: dropped
        { url: 'https://cdn.example.com/c.png' },
      ],
    }),
  )
  const result = await seedreamImagePlugin.submit(request, cfg, ctx)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.outputs?.length, 1)
  assert.equal(result.outputs![0].url, 'https://cdn.example.com/c.png')
  assert.equal(result.outputs![0].b64Json, undefined)

  const emptyCtx = contextFor(
    SEEDREAM_IMAGE_PLUGIN_VERSION,
    cfg,
    jsonFetch({ data: [{ error: { code: 'content_filtered' } }] }),
  )
  const empty = await seedreamImagePlugin.submit(request, cfg, emptyCtx)
  assert.equal(empty.status, 'failed')
  assert.equal(empty.error?.code, 'PROVIDER_EMPTY_RESULT')
})

test('openOutput rejects ambiguous, insecure, and non-image descriptors', async () => {
  const cfg = config()
  const ctx = contextFor(SEEDREAM_IMAGE_PLUGIN_VERSION, cfg, jsonFetch({}))
  await assert.rejects(
    () => seedreamImagePlugin.openOutput({ index: 0, mimeType: 'image/png', url: 'https://cdn.example.com/a.png', b64Json: 'x' }, cfg, ctx),
    (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'INVALID_REQUEST')
      assert.ok(err.diagnostic.detail.includes('exactly one'))
      return true
    },
  )
  await assert.rejects(
    () => seedreamImagePlugin.openOutput({ index: 0, mimeType: 'image/png' }, cfg, ctx),
    (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'INVALID_REQUEST')
      assert.ok(err.diagnostic.detail.includes('exactly one'))
      return true
    },
  )
  await assert.rejects(
    () => seedreamImagePlugin.openOutput({ index: 0, mimeType: 'image/png', url: 'http://cdn.example.com/a.png' }, cfg, ctx),
    (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'UNSAFE_URL')
      assert.ok(err.diagnostic.detail.includes('HTTPS'))
      return true
    },
  )
  await assert.rejects(
    () => seedreamImagePlugin.openOutput({ index: 0, mimeType: 'video/mp4', url: 'https://cdn.example.com/a.mp4' }, cfg, ctx),
    (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'INVALID_REQUEST')
      assert.ok(err.diagnostic.detail.includes('PNG/JPEG'))
      return true
    },
  )

  const lyingCtx = contextFor(
    SEEDREAM_IMAGE_PLUGIN_VERSION,
    cfg,
    (async () =>
      new Response('not an image', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof globalThis.fetch,
  )
  await assert.rejects(
    () => seedreamImagePlugin.openOutput({ index: 0, mimeType: 'image/png', url: 'https://ark.cn-beijing.volces.com/mock-image.png' }, cfg, lyingCtx),
    (err: unknown) => {
      assert.ok(err instanceof NormalizedProviderError)
      assert.equal(err.diagnostic.code, 'OUTPUT_READ_FAILED')
      return true
    },
  )
})

test('legacy 1.0.0 plugin keeps pinned-revision behavior', async () => {
  const cfg = config()
  const ctx = contextFor(
    '1.0.0',
    cfg,
    jsonFetch({ data: [{ url: 'https://ark.cn-beijing.volces.com/mock-image.png' }] }),
  )
  const result = await legacySeedreamImagePlugin.submit(
    {
      modality: 'image',
      vendorModelId: 'doubao-seedream-4-0-250828',
      prompt: 'ok',
      size: '1024x1024',
      count: 1,
      watermark: false,
    },
    cfg,
    ctx,
  )
  assert.equal(result.status, 'succeeded')

  const rejectedCtx = contextFor(
    '1.0.0',
    cfg,
    (async () => new Response('nope', { status: 400, statusText: 'Bad Request' })) as typeof globalThis.fetch,
  )
  const rejected = await legacySeedreamImagePlugin.submit(
    {
      modality: 'image',
      vendorModelId: 'doubao-seedream-4-0-250828',
      prompt: 'ok',
      size: '1024x1024',
      count: 1,
      watermark: false,
    },
    cfg,
    rejectedCtx,
  )
  assert.equal(rejected.status, 'failed')
  assert.equal(rejected.error?.code, 'PROVIDER_REJECTED')
})

test('probe uses GET models without triggering generation', async () => {
  const seen: Array<{ method?: string; url: string; body?: string }> = []
  const record = (status: number) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ method: init?.method, url: String(url), body: String(init?.body || '') })
      return new Response(JSON.stringify({ data: [] }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
  const cfg = config()

  const okCtx = contextFor(SEEDREAM_IMAGE_PLUGIN_VERSION, cfg, record(200))
  const healthy = await seedreamImagePlugin.probe(cfg, okCtx)
  assert.equal(healthy.healthy, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'GET')
  assert.equal(seen[0].url, 'https://ark.cn-beijing.volces.com/api/v3/models')
  assert.ok(!seen[0].url.includes('/images/generations'))
  assert.equal(seen[0].body, '')

  seen.length = 0
  const deniedCtx = contextFor(SEEDREAM_IMAGE_PLUGIN_VERSION, cfg, record(401))
  const denied = await seedreamImagePlugin.probe(cfg, deniedCtx)
  assert.equal(denied.healthy, false)
  assert.ok(String(denied.message).includes('401'))
  assert.ok(!seen[0].url.includes('/images/generations'))

  const downCtx = contextFor(SEEDREAM_IMAGE_PLUGIN_VERSION, cfg, record(503))
  const down = await seedreamImagePlugin.probe(cfg, downCtx)
  assert.equal(down.healthy, false)
})

test('active validateConfig pins ark.cn-beijing.volces.com and rejects compatible endpoints', () => {
  seedreamImagePlugin.validateConfig(config())
  for (const baseUrl of ['https://ark.example.com/api/v3', 'http://ark.cn-beijing.volces.com', 'https://ark.cn-beijing.volces.com.evil.example.com', 'not a url']) {
    assert.throws(
      () => seedreamImagePlugin.validateConfig({ ...config(), baseUrl }),
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
  const ctx = contextFor(SEEDREAM_IMAGE_PLUGIN_VERSION, cfg, (async () => {
    fetchCalls++
    return new Response(null, { status: 302, headers: { location: 'https://cdn.evil.example.com/x.png' } })
  }) as typeof globalThis.fetch)
  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: 'doubao-seedream-4-0-250828',
    prompt: 'ok',
    size: '1024x1024',
    count: 1,
    watermark: false,
  }
  await assert.rejects(
    () => seedreamImagePlugin.submit(request, cfg, ctx),
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
  const jpeg = await realJpeg(400, 500)
  const ctx = contextFor(SEEDREAM_IMAGE_PLUGIN_VERSION, cfg, jsonFetch({}))

  const legit = await seedreamImagePlugin.openOutput(
    { index: 0, mimeType: 'image/jpeg', b64Json: jpeg.toString('base64') },
    cfg,
    ctx,
  )
  assert.equal(legit.mimeType, 'image/jpeg')
  assert.equal(legit.width, 400)
  assert.equal(legit.height, 500)

  await assert.rejects(
    () =>
      seedreamImagePlugin.openOutput(
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
    SEEDREAM_IMAGE_PLUGIN_VERSION,
    cfg,
    (async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { 'content-type': 'image/png' } })) as typeof globalThis.fetch,
  )
  await assert.rejects(
    () =>
      seedreamImagePlugin.openOutput(
        { index: 0, mimeType: 'image/png', url: 'https://ark.cn-beijing.volces.com/spoofed.png' },
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
  const cfg = { ...config(), baseUrl: 'https://ark.example.com/api/v3' }
  let fetchCalls = 0
  const ctx = contextFor(SEEDREAM_IMAGE_PLUGIN_VERSION, config(), (async () => {
    fetchCalls++
    return new Response('{}', { status: 200 })
  }) as typeof globalThis.fetch)
  await assert.rejects(() => seedreamImagePlugin.probe(cfg, ctx), (err: unknown) => {
    assert.ok(err instanceof NormalizedProviderError)
    assert.equal(err.diagnostic.code, 'INVALID_CONFIG')
    return true
  })
  assert.equal(fetchCalls, 0)
})
