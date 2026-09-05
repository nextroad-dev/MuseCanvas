import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildLanguageModelRequest, callLanguageModel, inspectInputImage, LanguageModelHttpError, loadPromptTemplateIndex, MAX_UPLOAD_IMAGE_BYTES, MAX_UPLOAD_TOTAL_BYTES, normalizeSeedreamSize, parseExactJsonString, parseLanguageModelResponse, renderPromptTemplate, validateInputImages } from './index'

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

  // Absolute single-image ceiling rejects absurd inputs; resolved limits
  // enforce both raised and lowered settings without huge allocations.
  assert.throws(() => inspectInputImage(createMockPng(100, 100), { maxImageBytes: 10 }), /INVALID_INPUT_IMAGE_SIZE/)
  assert.equal(inspectInputImage(createMockPng(100, 100), { maxImageBytes: MAX_UPLOAD_IMAGE_BYTES }).width, 100)

  const tinyTotal = { maxTotalBytes: 40 }
  const twoTiny = [{ data: createMockPng(100, 100) }, { data: createMockPng(100, 100) }]
  assert.throws(() => validateInputImages(twoTiny, tinyTotal), /INVALID_INPUT_IMAGE_SIZE/)
  assert.equal(validateInputImages(twoTiny, { maxTotalBytes: MAX_UPLOAD_TOTAL_BYTES }).length, 2)

  const thirtyThree = Array.from({ length: 33 }, () => ({ data: createMockPng(100, 100) }))
  assert.throws(() => validateInputImages(thirtyThree), /INVALID_INPUT_IMAGE/)
  assert.throws(() => validateInputImages(twoTiny, { maxInputs: 1 }), /INVALID_INPUT_IMAGE/)
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
})


test('normalizes protocol responses and strictly validates structured JSON', () => {
  assert.equal(parseLanguageModelResponse('openai_chat', { id: 'a', choices: [{ message: { content: '{"ok":"yes"}' } }] }).text, '{"ok":"yes"}')
  assert.equal(parseLanguageModelResponse('openai_responses', { output: [{ role: 'assistant', content: [{ type: 'output_text', text: 'response' }] }] }).text, 'response')
  assert.equal(parseLanguageModelResponse('anthropic_messages', { content: [{ type: 'text', text: 'anthropic' }], stop_reason: 'end_turn' }).text, 'anthropic')
  assert.equal(parseExactJsonString('{"optimizedPrompt":" final "}', 'optimizedPrompt', 20), 'final')
  assert.throws(() => parseExactJsonString('{"optimizedPrompt":"ok","extra":1}', 'optimizedPrompt', 20), /PROMPT_OUTPUT_INVALID/)
  assert.throws(() => parseExactJsonString('```json', 'templateName', 20), /PROMPT_TEMPLATE_SELECTION_INVALID/)
})
