import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildLanguageModelRequest, generateImages, imageGenerationBody, loadPromptTemplateIndex, normalizeSeedreamSize, parseExactJsonString, parseLanguageModelResponse, ProviderHttpError, providerModelsEndpoint, renderPromptTemplate } from './index'

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

test('rejects symlinks resolving outside the template root', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'muse-outside-')); await writeFile(path.join(outside, 'secret.md'), 'secret')
  const root = await fixture({ templates: [{ name: 'A', description: 'one', path: 'linked.md' }] })
  try { await symlink(path.join(outside, 'secret.md'), path.join(root, 'linked.md')); const index = await loadPromptTemplateIndex(path.join(root, 'index.json')); assert.equal(index.valid, false); assert.equal(index.entries[0].errorCode, 'PROMPT_TEMPLATE_FILE_INVALID') } finally { await rm(root, { recursive: true }); await rm(outside, { recursive: true }) }
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

  const seedream = imageGenerationBody({ adapter: 'seedream', vendorModelId: 'doubao-seedream-4-5-251128', prompt: 'prompt', size: '2K', quality: 'high', count: 3, watermark: false })
  assert.deepEqual(seedream, { model: 'doubao-seedream-4-5-251128', prompt: 'prompt', size: '2K', response_format: 'url', watermark: false, stream: false, sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: 3 } })
  assert.equal('quality' in seedream, false)
  assert.equal('n' in seedream, false)
})

test('provider http errors carry sanitized upstream diagnostics', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('bad key sk-abcdefghijklmnopqrstuvwxyz0123456789 and upstream message', { status: 400, statusText: 'Bad Request' })
  try {
    await assert.rejects(
      () => generateImages({ adapter: 'seedream', vendorModelId: 'seedream', prompt: 'prompt', size: '2K', count: 1, watermark: false, apiKey: 'secret' }),
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

test('keeps Seedream explicit width-height sizes unchanged', () => {
  assert.equal(normalizeSeedreamSize('2K'), '2K')
  assert.equal(normalizeSeedreamSize('2048x2048'), '2048x2048')
  assert.equal(normalizeSeedreamSize('1024x1024'), '1024x1024')
  assert.equal(normalizeSeedreamSize('1280x720'), '1280x720')
  assert.equal(normalizeSeedreamSize('720x1280'), '720x1280')
  assert.throws(() => normalizeSeedreamSize('9999x9999'), /INVALID_IMAGE_SIZE/)
  assert.throws(() => normalizeSeedreamSize('9999x500'), /INVALID_IMAGE_SIZE/)

  const body = imageGenerationBody({ adapter: 'seedream', vendorModelId: 'seedream', prompt: 'prompt', size: '1024x1024', count: 1, watermark: false })
  assert.equal(body.size, '1024x1024')
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
