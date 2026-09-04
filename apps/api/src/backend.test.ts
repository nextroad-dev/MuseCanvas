import assert from 'node:assert/strict'
import test from 'node:test'
import { validateModelInput } from '../../../packages/domain/src/index'
import { hashOtp, safeEqual } from './auth/security'
import { adminJobDto, jobDto, modelDto, publicModelDto } from './shared/dto'
import {
  validateInputImageIdsSyntax,
  validateAndAttachGenerationInputs,
  GenerationInputError,
  MAX_UPLOAD_IMAGE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_INPUT_IMAGES,
} from './modules/generation-uploads'
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

test('upload constants match cross-slice specifications', () => {
  assert.equal(MAX_UPLOAD_IMAGE_BYTES, 10000000)
  assert.equal(MAX_UPLOAD_TOTAL_BYTES, 20000000)
  assert.equal(MAX_INPUT_IMAGES, 4)
})

test('publicModelDto and modelDto expose maxInputImages with 0 as default', () => {
  const baseRow = { id: 'm1', display_name: 'Model 1', adapter: 'openai', sizes: ['1024x1024'], enabled: true, sort_order: 1 }
  assert.equal(publicModelDto(baseRow).maxInputImages, 0)
  assert.equal(modelDto(baseRow).maxInputImages, 0)

  const rowWithMax = { ...baseRow, max_input_images: 4 }
  assert.equal(publicModelDto(rowWithMax).maxInputImages, 4)
  assert.equal(modelDto(rowWithMax).maxInputImages, 4)
})

test('jobDto exposes ordered inputImages and text-only jobs have empty inputImages', async () => {
  const base = {
    id: 'job-1',
    created_by: 'user-1',
    model_id: 'model-1',
    model_name: 'Image Model',
    prompt: 'test prompt',
    size: '1024x1024',
    count: 1,
    status: 'succeeded',
    created_at: new Date('2026-09-01T00:00:00Z'),
  }

  const textOnly = await jobDto(base)
  assert.deepEqual(textOnly.inputImages, [])

  const inputs = [
    { id: 'img-1', imageUrl: 'https://s3.example.com/img1.png', mimeType: 'image/png', width: 512, height: 512, sizeBytes: 1000 },
    { id: 'img-2', imageUrl: 'https://s3.example.com/img2.jpg', mimeType: 'image/jpeg', width: 1024, height: 768, sizeBytes: 2500 },
  ]
  const withInputs = await jobDto(base, [], inputs)
  assert.equal(withInputs.inputImages.length, 2)
  assert.equal(withInputs.inputImages[0].id, 'img-1')
  assert.equal(withInputs.inputImages[0].imageUrl, 'https://s3.example.com/img1.png')
  assert.equal(withInputs.inputImages[0].mimeType, 'image/png')
  assert.equal(withInputs.inputImages[0].width, 512)
  assert.equal(withInputs.inputImages[0].height, 512)
  assert.equal(withInputs.inputImages[0].sizeBytes, 1000)
  assert.equal(withInputs.inputImages[1].id, 'img-2')
  assert.equal(withInputs.inputImages[1].imageUrl, 'https://s3.example.com/img2.jpg')
})

test('adminJobDto preserves leak discipline and excludes input image data', () => {
  const dto = adminJobDto({
    id: 'job-id',
    created_by: 'user-id',
    model_id: 'model-id',
    model_name: 'Model',
    status: 'succeeded',
    created_at: new Date('2026-01-01T00:00:00Z'),
    input_images: [{ id: 'input-1', object_key: 'secret-key' }],
    inputImages: [{ id: 'input-1', imageUrl: 'secret-url' }],
  })
  assert.equal('inputImages' in dto, false)
  assert.equal('input_images' in dto, false)
  const serialized = JSON.stringify(dto)
  assert.equal(serialized.includes('secret-key'), false)
  assert.equal(serialized.includes('secret-url'), false)
})

test('validateInputImageIdsSyntax enforces product caps, model capability, duplicates and format', () => {
  const validUuid1 = '11111111-1111-4111-8111-111111111111'
  const validUuid2 = '22222222-2222-4222-8222-222222222222'
  const validUuid3 = '33333333-3333-4333-8333-333333333333'
  const validUuid4 = '44444444-4444-4444-8444-444444444444'
  const validUuid5 = '55555555-5555-4555-8555-555555555555'

  assert.deepEqual(validateInputImageIdsSyntax(undefined, 4), [])
  assert.deepEqual(validateInputImageIdsSyntax(null, 4), [])
  assert.deepEqual(validateInputImageIdsSyntax([], 4), [])
  assert.deepEqual(validateInputImageIdsSyntax([validUuid1, validUuid2], 4), [validUuid1, validUuid2])

  assert.throws(() => validateInputImageIdsSyntax('not-an-array', 4), (err: unknown) => err instanceof GenerationInputError && err.code === 'INVALID_INPUT')
  assert.throws(() => validateInputImageIdsSyntax(['not-a-uuid'], 4), (err: unknown) => err instanceof GenerationInputError && err.code === 'INVALID_INPUT')
  assert.throws(() => validateInputImageIdsSyntax(['------------------------------------'], 4), (err: unknown) => err instanceof GenerationInputError && err.code === 'INVALID_INPUT')
  assert.throws(() => validateInputImageIdsSyntax([validUuid1, validUuid1], 4), (err: unknown) => err instanceof GenerationInputError && err.code === 'INVALID_INPUT')
  assert.throws(() => validateInputImageIdsSyntax([validUuid1, validUuid2, validUuid3, validUuid4, validUuid5], 4), (err: unknown) => err instanceof GenerationInputError && err.code === 'INVALID_INPUT')

  assert.throws(() => validateInputImageIdsSyntax([validUuid1], 0), (err: unknown) => err instanceof GenerationInputError && err.code === 'MODEL_INPUT_IMAGES_NOT_SUPPORTED')
  assert.throws(() => validateInputImageIdsSyntax([validUuid1, validUuid2, validUuid3], 2), (err: unknown) => err instanceof GenerationInputError && err.code === 'INVALID_INPUT')
})

test('validateAndAttachGenerationInputs checks ownership, status, TTL, and total byte caps', async () => {
  const actorId = 'user-1'
  const jobId = 'job-1'
  const id1 = '11111111-1111-4111-8111-111111111111'
  const id2 = '22222222-2222-4222-8222-222222222222'

  const queries: Array<{ sql: string; params: unknown[] }> = []
  const makeMockClient = (rows: Record<string, unknown>[]) => ({
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params })
      if (sql.includes('SELECT id, status')) return { rows }
      return { rows: [] }
    },
  })

  // Missing or foreign IDs (fewer rows returned than requested)
  await assert.rejects(
    validateAndAttachGenerationInputs(makeMockClient([{ id: id1, status: 'ready', size_bytes: 1000, expires_at: new Date(Date.now() + 10000), deleted_at: null, attached_job_id: null }]), actorId, jobId, [id1, id2]),
    (err: unknown) => err instanceof GenerationInputError && err.code === 'INPUT_IMAGE_UNAVAILABLE'
  )

  // Deleted image
  await assert.rejects(
    validateAndAttachGenerationInputs(makeMockClient([{ id: id1, status: 'deleted', size_bytes: 1000, expires_at: new Date(Date.now() + 10000), deleted_at: new Date(), attached_job_id: null }]), actorId, jobId, [id1]),
    (err: unknown) => err instanceof GenerationInputError && err.code === 'INPUT_IMAGE_UNAVAILABLE'
  )

  // Pending image
  await assert.rejects(
    validateAndAttachGenerationInputs(makeMockClient([{ id: id1, status: 'pending', size_bytes: 1000, expires_at: new Date(Date.now() + 10000), deleted_at: null, attached_job_id: null }]), actorId, jobId, [id1]),
    (err: unknown) => err instanceof GenerationInputError && err.code === 'INVALID_INPUT_IMAGE'
  )

  // Already attached image
  await assert.rejects(
    validateAndAttachGenerationInputs(makeMockClient([{ id: id1, status: 'ready', size_bytes: 1000, expires_at: new Date(Date.now() + 10000), deleted_at: null, attached_job_id: 'other-job' }]), actorId, jobId, [id1]),
    (err: unknown) => err instanceof GenerationInputError && err.code === 'INVALID_INPUT_IMAGE'
  )

  // Expired image
  await assert.rejects(
    validateAndAttachGenerationInputs(makeMockClient([{ id: id1, status: 'ready', size_bytes: 1000, expires_at: new Date(Date.now() - 10000), deleted_at: null, attached_job_id: null }]), actorId, jobId, [id1]),
    (err: unknown) => err instanceof GenerationInputError && err.code === 'INPUT_IMAGE_UNAVAILABLE'
  )

  // Exceeds total size cap (20,000,000 bytes)
  await assert.rejects(
    validateAndAttachGenerationInputs(makeMockClient([
      { id: id1, status: 'ready', size_bytes: 11000000, expires_at: new Date(Date.now() + 10000), deleted_at: null, attached_job_id: null },
      { id: id2, status: 'ready', size_bytes: 10000000, expires_at: new Date(Date.now() + 10000), deleted_at: null, attached_job_id: null },
    ]), actorId, jobId, [id1, id2]),
    (err: unknown) => err instanceof GenerationInputError && err.code === 'INVALID_INPUT_IMAGE_SIZE'
  )

  // Valid attach
  const successQueries: Array<{ sql: string; params: unknown[] }> = []
  const successClient = {
    query: async (sql: string, params: unknown[]) => {
      successQueries.push({ sql, params })
      if (sql.includes('SELECT id, status')) {
        return {
          rows: [
            { id: id1, status: 'ready', size_bytes: 5000, expires_at: new Date(Date.now() + 10000), deleted_at: null, attached_job_id: null },
            { id: id2, status: 'ready', size_bytes: 8000, expires_at: new Date(Date.now() + 10000), deleted_at: null, attached_job_id: null },
          ],
        }
      }
      return { rows: [] }
    },
  }
  await validateAndAttachGenerationInputs(successClient, actorId, jobId, [id1, id2])
  const insert1 = successQueries.find(q => q.sql.includes('INSERT INTO generation_job_inputs') && q.params[1] === id1)
  const insert2 = successQueries.find(q => q.sql.includes('INSERT INTO generation_job_inputs') && q.params[1] === id2)
  assert.ok(insert1)
  assert.ok(insert2)
  assert.equal(insert1.params[2], 0)
  assert.equal(insert2.params[2], 1)
  const update1 = successQueries.find(q => q.sql.includes('UPDATE generation_input_images') && q.params[1] === id1)
  const update2 = successQueries.find(q => q.sql.includes('UPDATE generation_input_images') && q.params[1] === id2)
  assert.ok(update1)
  assert.ok(update2)
})
