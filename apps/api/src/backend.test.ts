import assert from 'node:assert/strict'
import test from 'node:test'
import { validateModelInput } from '../../../packages/domain/src/index'
import { hashOtp, safeEqual } from './auth/security'
import { adminJobDto, jobDto } from './shared/dto'
import { providerEndpoint, providerModelsEndpoint } from '../../../packages/providers/src/index'
import { retryPreparation } from './generation/job-retry'
import { modelPresets } from './admin/model-presets'

process.env.SESSION_SECRET = 'test-session-secret-with-enough-entropy'

test('OTP hashes are scoped to the email and compare in constant time', () => {
  const hash = hashOtp('one@example.com', '123456')
  assert.equal(safeEqual(hash, hashOtp('one@example.com', '123456')), true)
  assert.equal(safeEqual(hash, hashOtp('two@example.com', '123456')), false)
})

test('generation input accepts safe custom sizes, fixed quality values, and model-limited image counts', () => {
  const model = { adapter: 'openai', sizes: ['1024x1024'], qualityOptions: ['medium'], maxCount: 4 }
  const twoImageModel = { ...model, maxCount: 2 }
  const seedream45 = { ...model, adapter: 'seedream', vendorModelId: 'doubao-seedream-4-5-251128' }
  assert.equal(validateModelInput(model, { size: '1280x720', quality: 'auto', count: 4 }), null)
  assert.equal(validateModelInput(model, { size: '2K', quality: 'medium', count: 1 }), null)
  assert.equal(validateModelInput(model, { size: '3K', quality: 'medium', count: 1 }), null)
  assert.equal(validateModelInput({ ...model, adapter: 'seedream' }, { size: '1024x1024', quality: 'high', count: 2 }), null)
  assert.equal(validateModelInput(seedream45, { size: '2048x2048', quality: 'high', count: 2 }), null)
  assert.equal(validateModelInput(seedream45, { size: '5504x3040', quality: 'high', count: 1 }), null)
  assert.equal(validateModelInput(seedream45, { size: '1024x1024', quality: 'high', count: 1 }), 'INVALID_SIZE')
  assert.equal(validateModelInput(seedream45, { size: '2K', quality: 'high', count: 1 }), 'INVALID_SIZE')
  assert.equal(validateModelInput(model, { size: 'abc', quality: 'medium', count: 1 }), 'INVALID_SIZE')
  assert.equal(validateModelInput(model, { size: '99999x99999', quality: 'medium', count: 1 }), 'INVALID_SIZE')
  assert.equal(validateModelInput(model, { size: '1024x1024', quality: 'ultra', count: 1 }), 'INVALID_QUALITY')
  assert.equal(validateModelInput(twoImageModel, { size: '1024x1024', quality: 'medium', count: 3 }), 'INVALID_COUNT')
  assert.equal(validateModelInput(model, { size: '1024x1024', quality: 'medium', count: 5 }), 'INVALID_COUNT')
})

test('provider presets use verified model identifiers and reasoning output budgets', () => {
  const seedream = modelPresets.find(preset => preset.id === 'seedream-4-5')
  assert.equal(seedream?.vendorModelId, 'doubao-seedream-4-5-251128')
  assert.deepEqual(seedream?.modelKind === 'image' ? seedream.sizes.slice(0, 7) : [], ['2048x2048', '2304x1728', '1728x2304', '2848x1600', '1600x2848', '2496x1664', '1664x2496'])
  assert.equal(seedream?.modelKind === 'image' ? seedream.sizes.includes('1024x1024') : true, false)
  assert.equal(seedream?.modelKind === 'image' ? seedream.sizes.includes('5504x3040') : false, true)
  for (const id of ['openai-gpt-5-5', 'openai-gpt-5-4']) {
    const preset = modelPresets.find(candidate => candidate.id === id)
    assert.equal(preset?.modelKind === 'language' ? preset.maxOutputTokens : 0, 25000)
    assert.equal(preset && 'temperature' in preset ? preset.temperature : undefined, undefined)
  }
})

test('admin job diagnostics exclude prompts, objects, and image data', () => {
  const dto = adminJobDto({
    id: 'job-id', created_by: 'user-id', model_id: 'model-id', model_name: 'Model', status: 'failed', error_code: 'SAFE_ERROR',
    provider_error: { status: 400, detail: 'upstream rejected', providerReferenceId: 'nested-ref' },
    provider_reference_id: 'provider-ref', created_at: new Date('2026-01-01T00:00:00Z'), started_at: new Date('2026-01-01T00:00:00Z'), completed_at: new Date('2026-01-01T00:00:01Z'),
    prompt: 'must-not-leak', object_key: 'must-not-leak', image_url: 'must-not-leak',
  })
  assert.equal(dto.durationMs, 1000)
  assert.equal(dto.providerError?.status, 400)
  assert.equal(dto.providerReferenceId, 'provider-ref')
  assert.equal(dto.providerError?.providerReferenceId, 'nested-ref')
  const serialized = JSON.stringify(dto)
  assert.equal(serialized.includes('must-not-leak'), false)
  assert.equal('prompt' in dto, false)
})

test('user job DTO applies final prompt visibility without changing the original prompt', async () => {
  const base = { id: 'job', created_by: 'user', model_id: 'model', model_name: 'Image', prompt: 'internal-final', input_prompt: 'original', final_prompt: 'optimized', template_name_snapshot: 'Photo', phase: 'completed', optimization_mode: 'enabled', optimization_status: 'succeeded', size: '1K', count: 1, status: 'succeeded', created_at: new Date() }
  const hidden = await jobDto({ ...base, allow_user_read_final_prompt: false })
  assert.equal(hidden.prompt, 'original'); assert.equal(hidden.finalPrompt, null); assert.equal(hidden.canReadFinalPrompt, false)
  const visible = await jobDto({ ...base, allow_user_read_final_prompt: true })
  assert.equal(visible.finalPrompt, 'optimized'); assert.equal(visible.prompt, 'original')
})

test('manual retry resumes from the correct generation phase', () => {
  assert.deepEqual(retryPreparation({ optimization_mode: 'disabled' }), { phase: 'image_generating', resetOptimization: false })
  assert.deepEqual(retryPreparation({ optimization_mode: 'enabled', prompt_optimization_id: 'po', final_prompt: 'optimized prompt', template_instruction_snapshot: 'template' }), { phase: 'image_generating', resetOptimization: false })
  assert.deepEqual(retryPreparation({ optimization_mode: 'enabled', prompt_optimization_id: 'po', template_instruction_snapshot: 'template' }), { phase: 'template_selected', resetOptimization: true })
  assert.deepEqual(retryPreparation({ optimization_mode: 'enabled', prompt_optimization_id: 'po' }), { phase: 'template_selecting', resetOptimization: true })
})

test('provider endpoints accept service roots and versioned compatible roots', () => {
  assert.equal(providerEndpoint('openai', 'https://proxy.example.com'), 'https://proxy.example.com/v1/images/generations')
  assert.equal(providerEndpoint('openai', 'https://proxy.example.com/openai/v1'), 'https://proxy.example.com/openai/v1/images/generations')
  assert.equal(providerModelsEndpoint('https://proxy.example.com/openai/v1'), 'https://proxy.example.com/openai/v1/models')
  assert.equal(providerEndpoint('seedream', 'https://ark.example.com'), 'https://ark.example.com/api/v3/images/generations')
  assert.equal(providerEndpoint('seedream', 'https://ark.example.com/api/v3'), 'https://ark.example.com/api/v3/images/generations')
})

test('seedream provider test should use the image generation endpoint, not the chat/models endpoint', () => {
  assert.equal(providerEndpoint('seedream', 'https://ark.cn-beijing.volces.com'), 'https://ark.cn-beijing.volces.com/api/v3/images/generations')
})
