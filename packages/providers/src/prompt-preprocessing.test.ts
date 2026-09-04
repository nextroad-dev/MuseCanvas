import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildLanguageModelRequest, callLanguageModel, generateImages, imageGenerationBody, inspectInputImage, LanguageModelHttpError, limitGeneratedImages, loadPromptTemplateIndex, MAX_UPLOAD_IMAGE_BYTES, normalizeSeedreamSize, parseExactJsonString, parseLanguageModelResponse, ProviderHttpError, providerEndpoint, providerModelsEndpoint, renderPromptTemplate, validateInputImages } from './index'

async function fixture(index: unknown, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'muse-templates-'))
  for (const [relative, content] of Object.entries(files)) { const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content) }
  await writeFile(path.join(root, 'index.json'), JSON.stringify(index))
  return root
}

test('loads nested markdown and renders only whitelisted variables', async () => {
  const root = await fixture({ templates: [{ name: 'Photo', description: 'Photography', path: 'photo/real.md' }] }, { 'photo/real.md': 'Draw {{input_prompt}} at {{size}}' })
  try { const index = await loadPromptTemplateIndex(path.join(root, 'index.json')); assert.equal(index.valid, true); assert.equal(index.entries[0].sha256?.length, 64); assert.equal(renderPromptTemplate(index.entries[0].instruction!, { input_prompt: 'a tree', size: '1K' }), 'Draw a tree at 1K') } finally { await rm(root, { recursive: true }) }
})

test('rejects duplicate names, unknown fields, traversal, invalid variables and missing files', async () => {
  const cases = [
    { templates: [{ name: 'A', description: 'one', path: 'a.md' }, { name: 'A', description: 'two', path: 'b.md' }] },
    { templates: [{ name: 'A', description: 'one', path: 'a.md', extra: true }] },
    { templates: [{ name: 'A', description: 'one', path: '../a.md' }] },
    { templates: [{ name: 'A', description: 'one', path: 'missing.md' }] },
  ]
  for (const value of cases) { const root = await fixture(value, { 'a.md': 'ok', 'b.md': 'ok' }); try { assert.equal((await loadPromptTemplateIndex(path.join(root, 'index.json'))).valid, false) } finally { await rm(root, { recursive: true }) } }
  const root = await fixture({ templates: [{ name: 'A', description: 'one', path: 'a.md' }] }, { 'a.md': '{{unknown}}' }); try { assert.equal((await loadPromptTemplateIndex(path.join(root, 'index.json'))).valid, false) } finally { await rm(root, { recursive: true }) }
})

test('rejects symlinks resolving outside the template root', async (t) => {
  const outside = await mkdtemp(path.join(tmpdir(), 'muse-outside-')); await writeFile(path.join(outside, 'secret.md'), 'secret')
  const root = await fixture({ templates: [{ name: 'A', description: 'one', path: 'linked.md' }] })
  try {
    try {
      await symlink(path.join(outside, 'secret.md'), path.join(root, 'linked.md'))
    } catch (err) {
      if (process.platform === 'win32' && err instanceof Error && 'code' in err && err.code === 'EPERM') {
        t.skip('Windows symlink creation requires elevated privileges')
        return
      }
      throw err
    }
    const index = await loadPromptTemplateIndex(path.join(root, 'index.json')); assert.equal(index.valid, false); assert.equal(index.entries[0].errorCode, 'PROMPT_TEMPLATE_FILE_INVALID')
  } finally { await rm(root, { recursive: true }); await rm(outside, { recursive: true }) }
})

const baseInput = { vendorModelId: 'model', apiKey: 'secret', system: 'system', user: 'user', schemaName: 'result', schema: { type: 'object' }, maxOutputTokens: 100, timeoutMs: 1000 }
test('builds each language protocol with fixed endpoints and authentication headers', () => {
  const chat = buildLanguageModelRequest({ ...baseInput, protocol: 'openai_chat' }); assert.equal(chat.url, 'https://api.openai.com/v1/chat/completions'); assert.equal(chat.headers.authorization, 'Bearer secret'); assert.ok(chat.body.response_format)
  const responses = buildLanguageModelRequest({ ...baseInput, protocol: 'openai_responses' }); assert.equal(responses.url, 'https://api.openai.com/v1/responses'); assert.ok(responses.body.text)
  const anthropic = buildLanguageModelRequest({ ...baseInput, protocol: 'anthropic_messages' }); assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages'); assert.equal(anthropic.headers['x-api-key'], 'secret'); assert.equal(anthropic.headers['anthropic-version'], '2023-06-01')
})

test('builds plain text language requests without forcing JSON schema', () => {
  const plain = buildLanguageModelRequest({ vendorModelId: 'model', apiKey: 'secret', system: 'system', user: 'user', maxOutputTokens: 100, timeoutMs: 1000, protocol: 'openai_responses' })
  assert.equal('text' in plain.body, false)
  assert.equal('temperature' in plain.body, false)
})

test('passes reasoning effort to OpenAI Responses requests only', () => {
  const responses = buildLanguageModelRequest({ vendorModelId: 'gpt-5.5', apiKey: 'secret', system: 'system', user: 'user', maxOutputTokens: 100, timeoutMs: 1000, protocol: 'openai_responses', reasoningEffort: 'high' })
  assert.deepEqual(responses.body.reasoning, { effort: 'high' })
  const chat = buildLanguageModelRequest({ vendorModelId: 'gpt-5.5', apiKey: 'secret', system: 'system', user: 'user', maxOutputTokens: 100, timeoutMs: 1000, protocol: 'openai_chat', reasoningEffort: 'high' })
  assert.equal('reasoning' in chat.body, false)
})

test('builds image generation bodies with provider-specific fields only', () => {
  const openai = imageGenerationBody({ adapter: 'openai', vendorModelId: 'gpt-image-2', prompt: 'prompt', size: '1024x1024', quality: 'auto', count: 2, watermark: true })
  assert.deepEqual(openai, { model: 'gpt-image-2', prompt: 'prompt', size: '1024x1024', quality: 'auto', output_format: 'png', n: 2 })
  assert.equal('watermark' in openai, false)
  assert.equal('stream' in openai, false)

  const seedream = imageGenerationBody({ adapter: 'seedream', vendorModelId: 'doubao-seedream-4-5-251128', prompt: 'prompt', size: '2048x2048', quality: 'high', count: 3, watermark: false })
  assert.deepEqual(seedream, { model: 'doubao-seedream-4-5-251128', prompt: 'prompt', size: '2048x2048', response_format: 'url', watermark: false, stream: false, sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: 3 } })
  assert.equal('quality' in seedream, false)
  assert.equal('n' in seedream, false)
})

test('caps provider image results to the requested count', () => {
  assert.deepEqual(limitGeneratedImages(['a', 'b'], 1), ['a'])
  assert.deepEqual(limitGeneratedImages(['a', 'b', 'c'], 2), ['a', 'b'])
})

function createMockPng(width = 100, height = 100): Buffer {
  const buf = Buffer.alloc(33)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'latin1')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf[24] = 8
  buf[25] = 6
  return buf
}

function createMockJpeg(width = 100, height = 100): Buffer {
  const buf = Buffer.alloc(14)
  buf[0] = 0xff
  buf[1] = 0xd8
  buf[2] = 0xff
  buf[3] = 0xc0
  buf.writeUInt16BE(11, 4)
  buf[6] = 8
  buf.writeUInt16BE(height, 7)
  buf.writeUInt16BE(width, 9)
  buf[11] = 3
  buf[12] = 0xff
  buf[13] = 0xd9
  return buf
}

test('inspectInputImage validates PNG/JPEG magic, dimension bounds, aspect ratio and size cap', () => {
  const png = inspectInputImage(createMockPng(100, 100))
  assert.deepEqual(png, { width: 100, height: 100, mimeType: 'image/png', sizeBytes: 33 })

  const jpeg = inspectInputImage(createMockJpeg(200, 300))
  assert.deepEqual(jpeg, { width: 200, height: 300, mimeType: 'image/jpeg', sizeBytes: 14 })

  assert.equal(inspectInputImage(createMockPng(32, 32)).width, 32)
  assert.equal(inspectInputImage(createMockPng(6000, 6000)).width, 6000)
  assert.equal(inspectInputImage(createMockPng(1600, 100)).width, 1600)
  assert.equal(inspectInputImage(createMockPng(100, 1600)).height, 1600)

  assert.throws(() => inspectInputImage(Buffer.alloc(0)), /INVALID_INPUT_IMAGE/)
  assert.throws(() => inspectInputImage(Buffer.from('not an image header at all')), /INVALID_INPUT_IMAGE/)
  assert.throws(() => inspectInputImage(createMockPng(31, 100)), /INVALID_INPUT_IMAGE_SIZE/)
  assert.throws(() => inspectInputImage(createMockPng(100, 31)), /INVALID_INPUT_IMAGE_SIZE/)
  assert.throws(() => inspectInputImage(createMockPng(6001, 100)), /INVALID_INPUT_IMAGE_SIZE/)
  assert.throws(() => inspectInputImage(createMockPng(100, 6001)), /INVALID_INPUT_IMAGE_SIZE/)
  assert.throws(() => inspectInputImage(createMockPng(1700, 100)), /INVALID_INPUT_IMAGE_SIZE/)
  assert.throws(() => inspectInputImage(createMockPng(100, 1700)), /INVALID_INPUT_IMAGE_SIZE/)

  const oversizeSingle = Buffer.alloc(MAX_UPLOAD_IMAGE_BYTES + 1)
  assert.throws(() => inspectInputImage(oversizeSingle), /INVALID_INPUT_IMAGE_SIZE/)

  const img1 = { data: Buffer.alloc(MAX_UPLOAD_IMAGE_BYTES) }
  img1.data.set(createMockPng(100, 100), 0)
  const img2 = { data: Buffer.alloc(MAX_UPLOAD_IMAGE_BYTES) }
  img2.data.set(createMockPng(100, 100), 0)
  const img3 = { data: createMockPng(100, 100) }
  assert.throws(() => validateInputImages([img1, img2, img3]), /INVALID_INPUT_IMAGE_SIZE/)

  const five = [1, 2, 3, 4, 5].map(() => ({ data: createMockPng(100, 100) }))
  assert.throws(() => validateInputImages(five), /INVALID_INPUT_IMAGE/)
})

test('routes endpoints and builds bodies for image inputs while preserving no-image compatibility', () => {
  assert.equal(providerEndpoint('openai'), 'https://api.openai.com/v1/images/generations')
  assert.equal(providerEndpoint('openai', 'https://proxy.example.com/v1'), 'https://proxy.example.com/v1/images/generations')
  assert.equal(providerEndpoint('openai', undefined, 'edits'), 'https://api.openai.com/v1/images/edits')
  assert.equal(providerEndpoint('openai', undefined, [{ data: createMockPng(100, 100) }]), 'https://api.openai.com/v1/images/edits')

  assert.equal(providerEndpoint('seedream'), 'https://ark.cn-beijing.volces.com/api/v3/images/generations')
  assert.equal(providerEndpoint('seedream', undefined, 'edits'), 'https://ark.cn-beijing.volces.com/api/v3/images/generations')

  const mockPng = createMockPng(100, 100)
  const mockJpeg = createMockJpeg(200, 200)

  const seedreamSingle = imageGenerationBody({
    adapter: 'seedream',
    vendorModelId: 'doubao-seedream-4-5-251128',
    prompt: 'blend picture',
    size: '2048x2048',
    count: 1,
    watermark: false,
    inputImages: [{ data: mockPng, mimeType: 'image/png' }],
  })
  assert.equal(typeof seedreamSingle.image, 'string')
  assert.equal(String(seedreamSingle.image).startsWith('data:image/png;base64,'), true)
  assert.equal(seedreamSingle.response_format, 'url')

  const seedreamMulti = imageGenerationBody({
    adapter: 'seedream',
    vendorModelId: 'doubao-seedream-4-5-251128',
    prompt: 'blend pictures',
    size: '2048x2048',
    count: 2,
    watermark: false,
    inputImages: [{ data: mockPng, mimeType: 'image/png' }, { data: mockJpeg, mimeType: 'image/jpeg' }],
  })
  const seedreamUrls = seedreamMulti.image as string[]
  assert.equal(Array.isArray(seedreamUrls), true)
  assert.equal(seedreamUrls.length, 2)
  assert.equal(seedreamUrls[0].startsWith('data:image/png;base64,'), true)
  assert.equal(seedreamUrls[1].startsWith('data:image/jpeg;base64,'), true)
})

test('generateImages routes OpenAI to edits endpoint and handles invalid input image bytes', async () => {
  await assert.rejects(
    () => generateImages({
      adapter: 'openai',
      vendorModelId: 'gpt-image-2',
      prompt: 'p',
      size: '1024x1024',
      count: 1,
      watermark: false,
      apiKey: 'secret',
      inputImages: [{ data: Buffer.from('bad bytes') }],
    }),
    /INVALID_INPUT_IMAGE/,
  )

  await assert.rejects(
    () => generateImages({
      adapter: 'seedream',
      vendorModelId: 'doubao-seedream-4-0-250828',
      prompt: 'p',
      size: '1024x1024',
      count: 1,
      watermark: false,
      apiKey: 'secret',
      inputImages: [{ data: createMockPng(10, 10) }],
    }),
    /INVALID_INPUT_IMAGE_SIZE/,
  )

  const originalFetch = globalThis.fetch
  let calledUrl = ''
  const requests: RequestInit[] = []
  const mockOutputPng = createMockPng(1024, 1024)

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calledUrl = String(input)
    requests.push(init || {})
    return new Response(JSON.stringify({
      data: [{ b64_json: mockOutputPng.toString('base64') }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const images = await generateImages({
      adapter: 'openai',
      vendorModelId: 'gpt-image-2',
      prompt: 'edit prompt',
      size: '1024x1024',
      count: 1,
      watermark: false,
      apiKey: 'test-key',
      inputImages: [
        { data: createMockPng(100, 100), mimeType: 'image/png' },
        { data: createMockJpeg(120, 120), mimeType: 'image/jpeg' },
      ],
    })
    assert.equal(calledUrl, 'https://api.openai.com/v1/images/edits')
    const calledRequest = requests[0]
    assert.ok(calledRequest)
    assert.equal(new Headers(calledRequest.headers).get('content-type'), null)
    assert.equal(calledRequest.body instanceof FormData, true)
    const calledBody = calledRequest.body as FormData
    assert.equal(calledBody.get('model'), 'gpt-image-2')
    assert.equal(calledBody.get('prompt'), 'edit prompt')
    assert.equal(calledBody.get('size'), '1024x1024')
    assert.equal(calledBody.get('output_format'), 'png')
    assert.equal(calledBody.get('n'), '1')
    const sentImages = calledBody.getAll('image[]')
    assert.equal(sentImages.length, 2)
    assert.equal(sentImages[0] instanceof Blob, true)
    assert.equal((sentImages[0] as File).type, 'image/png')
    assert.equal(sentImages[1] instanceof Blob, true)
    assert.equal((sentImages[1] as File).type, 'image/jpeg')
    assert.equal(images.length, 1)
    assert.equal(images[0].mimeType, 'image/png')
    assert.equal(images[0].width, 1024)
    assert.equal(images[0].height, 1024)
  } finally {
    globalThis.fetch = originalFetch
  }
  let seedreamCalledUrl = ''
  let seedreamCalledBody: Record<string, unknown> = {}
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input)
    if (urlStr === 'https://cdn.volces.com/generated.png') {
      return new Response(Uint8Array.from(mockOutputPng), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }
    seedreamCalledUrl = urlStr
    seedreamCalledBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({
      data: [{ url: 'https://cdn.volces.com/generated.png' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const seedreamImages = await generateImages({
      adapter: 'seedream',
      vendorModelId: 'doubao-seedream-4-0-250828',
      prompt: 'seedream edit',
      size: '1024x1024',
      count: 1,
      watermark: false,
      apiKey: 'test-key',
      inputImages: [{ data: createMockPng(100, 100) }],
    })
    assert.equal(seedreamCalledUrl, 'https://ark.cn-beijing.volces.com/api/v3/images/generations')
    assert.equal(typeof seedreamCalledBody.image, 'string')
    assert.equal(seedreamImages.length, 1)
    assert.equal(seedreamImages[0].mimeType, 'image/png')
    assert.equal(seedreamImages[0].width, 1024)
    assert.equal(seedreamImages[0].height, 1024)
  } finally {
    globalThis.fetch = originalFetch
  }

  globalThis.fetch = async () => new Response('upstream edit error', { status: 400, statusText: 'Bad Request' })
  try {
    await assert.rejects(
      () => generateImages({
        adapter: 'openai',
        vendorModelId: 'gpt-image-2',
        prompt: 'p',
        size: '1024x1024',
        count: 1,
        watermark: false,
        apiKey: 'secret',
        inputImages: [{ data: createMockPng(100, 100) }],
      }),
      (error: unknown) => {
        assert.equal(error instanceof ProviderHttpError, true)
        const diagnostic = (error as ProviderHttpError).diagnostic
        assert.equal(diagnostic.status, 400)
        assert.equal(diagnostic.endpoint, '/v1/images/edits')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('provider transport failures remain retryable', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
  try {
    await assert.rejects(
      () => generateImages({
        adapter: 'openai',
        vendorModelId: 'gpt-image-2',
        prompt: 'prompt',
        size: '1024x1024',
        count: 1,
        watermark: false,
        apiKey: 'secret',
      }),
      /PROVIDER_TEMPORARY_ERROR/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('provider http errors carry sanitized upstream diagnostics', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('bad key sk-abcdefghijklmnopqrstuvwxyz0123456789 and upstream message', { status: 400, statusText: 'Bad Request' })
  try {
    await assert.rejects(
      () => generateImages({ adapter: 'seedream', vendorModelId: 'seedream', prompt: 'prompt', size: '2048x2048', count: 1, watermark: false, apiKey: 'secret' }),
      (error: unknown) => {
        assert.equal(error instanceof ProviderHttpError, true)
        const diagnostic = (error as ProviderHttpError).diagnostic
        assert.equal(diagnostic.status, 400)
        assert.equal(diagnostic.endpoint, '/api/v3/images/generations')
        assert.equal(diagnostic.detail.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'), false)
        assert.equal(diagnostic.detail.includes('upstream message'), true)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('language model http errors carry sanitized upstream diagnostics', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('bad key sk-abcdefghijklmnopqrstuvwxyz0123456789 and upstream unavailable', { status: 503, statusText: 'Service Unavailable', headers: { 'x-request-id': 'req-language-1' } })
  try {
    await assert.rejects(
      () => callLanguageModel({ protocol: 'openai_responses', vendorModelId: 'gpt', apiKey: 'secret', system: 'system', user: 'user', maxOutputTokens: 100, timeoutMs: 1000 }),
      (error: unknown) => {
        assert.equal(error instanceof LanguageModelHttpError, true)
        const diagnostic = (error as LanguageModelHttpError).diagnostic
        assert.equal(diagnostic.status, 503)
        assert.equal(diagnostic.endpoint, '/v1/responses')
        assert.equal(diagnostic.providerReferenceId, 'req-language-1')
        assert.equal(diagnostic.detail.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'), false)
        assert.equal(diagnostic.detail.includes('upstream unavailable'), true)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('validates Seedream way-two pixel sizes by model', () => {
  assert.equal(normalizeSeedreamSize('1024x1024', 'doubao-seedream-4-0-250828'), '1024x1024')
  assert.equal(normalizeSeedreamSize('1280x720', 'doubao-seedream-4-0-250828'), '1280x720')
  assert.equal(normalizeSeedreamSize('2048x2048', 'doubao-seedream-4-5-251128'), '2048x2048')
  assert.equal(normalizeSeedreamSize('5504x3040', 'doubao-seedream-4-5-251128'), '5504x3040')
  assert.equal(normalizeSeedreamSize('4096x2304', 'doubao-seedream-5-0-lite'), '4096x2304')
  assert.throws(() => normalizeSeedreamSize('2K', 'doubao-seedream-4-5-251128'), /INVALID_IMAGE_SIZE/)
  assert.throws(() => normalizeSeedreamSize('800x800', 'doubao-seedream-4-0-250828'), /INVALID_IMAGE_SIZE/)
  assert.throws(() => normalizeSeedreamSize('1024x1024', 'doubao-seedream-4-5-251128'), /INVALID_IMAGE_SIZE/)
  assert.throws(() => normalizeSeedreamSize('4096x4096', 'doubao-seedream-5-0-lite'), /INVALID_IMAGE_SIZE/)
  assert.throws(() => normalizeSeedreamSize('16001x1000', 'doubao-seedream-4-5-251128'), /INVALID_IMAGE_SIZE/)

  const body = imageGenerationBody({ adapter: 'seedream', vendorModelId: 'doubao-seedream-4-5-251128', prompt: 'prompt', size: '2048x2048', count: 1, watermark: false })
  assert.equal(body.size, '2048x2048')
})

test('normalizes OpenAI compatible models endpoint without duplicating v1', () => {
  assert.equal(providerModelsEndpoint('https://api.openai.com'), 'https://api.openai.com/v1/models')
  assert.equal(providerModelsEndpoint('https://proxy.example.com/openai/v1'), 'https://proxy.example.com/openai/v1/models')
})

test('normalizes protocol responses and strictly validates structured JSON', () => {
  assert.equal(parseLanguageModelResponse('openai_chat', { id: 'a', choices: [{ message: { content: '{"ok":"yes"}' } }] }).text, '{"ok":"yes"}')
  assert.equal(parseLanguageModelResponse('openai_responses', { output: [{ role: 'assistant', content: [{ type: 'output_text', text: 'response' }] }] }).text, 'response')
  assert.equal(parseLanguageModelResponse('anthropic_messages', { content: [{ type: 'text', text: 'anthropic' }], stop_reason: 'end_turn' }).text, 'anthropic')
  assert.equal(parseExactJsonString('{"optimizedPrompt":" final "}', 'optimizedPrompt', 20), 'final')
  assert.throws(() => parseExactJsonString('{"optimizedPrompt":"ok","extra":1}', 'optimizedPrompt', 20), /PROMPT_OUTPUT_INVALID/)
  assert.throws(() => parseExactJsonString('```json', 'templateName', 20), /PROMPT_TEMPLATE_SELECTION_INVALID/)
})
