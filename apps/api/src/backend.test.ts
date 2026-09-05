import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { retryPreparation } from './generation/job-retry'
import { globalProviderRegistry } from '../../../packages/providers/src/index'
import { modelPresets, type VideoModelPreset } from './admin/model-presets'
import { buildBuiltinProviderTemplates } from './admin/provider-templates'
import { ACTIVE_IMAGE_PLUGIN_VERSION, buildCanonicalImageCapabilities, imageBaseUrlAllowed, isEmptyInputOverride, manifestSupportsVendorModel, presetMatchesPersistedModel, providerCredentialMatchesPluginTarget, validateImageModelContract, validatePluginSelection, videoPresetRevisionContract } from './modules/models/handlers'
import { credentialTargetChanged, normalizeCredentialSchemaVersion, resolveCredentialPlugin, validateExplicitPluginCredential } from './modules/admin/provider-credentials'
import type pg from 'pg'
import {
  asValidationError,
  buildPromptTemplateExportPayload,
  isPromptTemplateSetId,
  promptTemplateExportFilename,
  renderPromptTemplatePreview,
  toPromptTemplateSetSummaryDto,
  validatePromptTemplateEntryCreate,
  validatePromptTemplateEntryPatch,
  validatePromptTemplateImport,
  validatePromptTemplatePreview,
} from './modules/admin/prompt-templates'
import {
  computePromptTemplateDigest,
  createPromptTemplateEntry,
  deletePromptTemplateEntry,
  deletePromptTemplateSet,
  updatePromptTemplateEntry,
} from '../../../packages/database/src/repositories/prompt-templates'
import { validateTemplateImport as validateSetupTemplateImport } from './modules/setup/validation'

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

test('image plugin manifests declare hardened host allowlists instead of adapter endpoints', () => {
  const openai = globalProviderRegistry.get('openai-image', '1.1.0').manifest
  assert.ok(openai.modalities.includes('image'))
  assert.ok(openai.allowedHosts.includes('api.openai.com'))
  const seedream = globalProviderRegistry.get('seedream-image', '1.1.0').manifest
  assert.ok(seedream.modalities.includes('image'))
  assert.ok(seedream.allowedHosts.includes('ark.cn-beijing.volces.com'))
})

test('upload constants expose the setup-allowed absolute ceilings', () => {
  assert.equal(MAX_UPLOAD_IMAGE_BYTES, 100_000_000)
  assert.equal(MAX_UPLOAD_TOTAL_BYTES, 200_000_000)
  assert.equal(MAX_INPUT_IMAGES, 32)
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
    ]), actorId, jobId, [id1, id2], {
      maxImageBytes: 20_000_000,
      maxTotalBytes: 20_000_000,
      maxInputs: 4,
    }),
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

test('image presets pin new configuration to the hardened 1.1.0 plugin keys', () => {
  assert.equal(ACTIVE_IMAGE_PLUGIN_VERSION, '1.1.0')
  const imagePresets = modelPresets.filter((preset) => preset.modelKind === 'image')
  assert.ok(imagePresets.length >= 3)
  for (const preset of imagePresets) {
    if (!('pluginId' in preset)) continue
    assert.ok(['openai-image', 'seedream-image'].includes(preset.pluginId as string))
    assert.equal(preset.pluginVersion, '1.1.0')
  }
  for (const pluginId of ['openai-image', 'seedream-image']) {
    assert.equal(globalProviderRegistry.has(pluginId, '1.1.0'), true)
    // Exact historical keys stay registered so already-pinned revisions resolve.
    assert.equal(globalProviderRegistry.has(pluginId, '1.0.0'), true)
    const manifest = globalProviderRegistry.get(pluginId, '1.1.0').manifest
    assert.ok(manifest.modalities.includes('image'))
  }
})

test('plugin selection validates through the registry and manifest modality', () => {
  assert.deepEqual(validatePluginSelection('openai-image', '1.1.0', 'image'), { ok: true, mediaKind: 'image' })
  assert.deepEqual(validatePluginSelection('seedream-image', '1.1.0', 'image'), { ok: true, mediaKind: 'image' })
  // Historical exact keys remain accepted for already-pinned revisions.
  assert.deepEqual(validatePluginSelection('openai-image', '1.0.0', 'image'), { ok: true, mediaKind: 'image' })
  assert.deepEqual(validatePluginSelection('seedream-image', '1.0.0', 'image'), { ok: true, mediaKind: 'image' })
  assert.deepEqual(validatePluginSelection('does-not-exist', '9.9.9', 'image'), { ok: false, error: 'INVALID_PLUGIN' })
  assert.deepEqual(validatePluginSelection('openai-image', '9.9.9', 'image'), { ok: false, error: 'INVALID_PLUGIN' })
  // Manifest modality mismatch is rejected rather than adapter-routed.
  assert.deepEqual(validatePluginSelection('openai-image', '1.1.0', 'video'), { ok: false, error: 'INVALID_MODALITY' })
  assert.deepEqual(validatePluginSelection('seedream-image', '1.1.0', 'video'), { ok: false, error: 'INVALID_MODALITY' })
})

test('credential probe resolves explicit plugin identity and never guesses from provider', () => {
  assert.deepEqual(
    resolveCredentialPlugin({ plugin_id: 'seedream-image', plugin_version: '1.1.0' }, {}),
    { pluginId: 'seedream-image', pluginVersion: '1.1.0' },
  )
  assert.deepEqual(
    resolveCredentialPlugin(null, { configured_fields: { pluginId: 'openai-image', pluginVersion: '1.1.0' } }),
    { pluginId: 'openai-image', pluginVersion: '1.1.0' },
  )
  assert.deepEqual(
    resolveCredentialPlugin(null, { configured_fields: JSON.stringify({ pluginId: 'openai-image', pluginVersion: '1.0.0' }) }),
    { pluginId: 'openai-image', pluginVersion: '1.0.0' },
  )
  // Linked identity wins over the credential's own configured identity.
  assert.deepEqual(
    resolveCredentialPlugin(
      { plugin_id: 'seedream-image', plugin_version: '1.1.0' },
      { configured_fields: { pluginId: 'openai-image', pluginVersion: '1.1.0' } },
    ),
    { pluginId: 'seedream-image', pluginVersion: '1.1.0' },
  )
  // An unlinked credential without plugin identity resolves to null so the
  // probe can return a clear PLUGIN_NOT_LINKED error instead of guessing.
  assert.equal(resolveCredentialPlugin(null, {}), null)
  assert.equal(resolveCredentialPlugin(null, { configured_fields: {} }), null)
  assert.equal(resolveCredentialPlugin({ plugin_id: 'seedream-image' }, {}), null)
})

test('historical 1.0.0 revision rows stay readable through the model DTOs', () => {
  const legacyRow = {
    id: 'model-legacy', display_name: 'Legacy', adapter: 'seedream', provider_id: 'volcengine',
    plugin_id: 'seedream-image', plugin_version: '1.0.0', model_kind: 'image',
    sizes: JSON.stringify(['1024x1024']), quality_options: JSON.stringify([]),
    max_count: 4, max_input_images: 4, enabled: true, sort_order: 0, credits_per_image: 5,
  }
  assert.equal(publicModelDto(legacyRow).pluginVersion, '1.0.0')
  assert.equal(modelDto(legacyRow).pluginVersion, '1.0.0')
  assert.equal(modelDto(legacyRow).adapter, 'seedream')
})

test('image 1.1.0 cutover appends immutable revisions without rewriting history', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '../../../packages/database/src/migrate.ts'), 'utf8')
  const cutover = source.slice(source.indexOf('10. Image plugin 1.1.0 cutover'))
  assert.ok(cutover.includes("'1.1.0'"))
  assert.ok(cutover.includes('INSERT INTO model_config_revisions'))
  assert.ok(cutover.includes('NOT EXISTS'))
  assert.ok(cutover.includes('latest_revision_id'))
  assert.equal(cutover.includes('UPDATE model_config_revisions'), false)
  assert.equal(cutover.includes('DELETE FROM model_config_revisions'), false)
  assert.equal(/ALTER TABLE model_configs DROP COLUMN/i.test(cutover), false)
  // Nonterminal jobs pin the pre-cutover revision before models advance.
  assert.ok(cutover.includes('UPDATE generation_jobs'))
  assert.ok(cutover.includes('model_revision_id'))
  for (const status of ['queued', 'running', 'retry_wait']) {
    assert.ok(cutover.includes(`'${status}'`))
  }
  assert.ok(cutover.indexOf('UPDATE generation_jobs') < cutover.indexOf('UPDATE model_configs'))
  // Only rows from the known current image presets advance, and only when
  // persisted fields conform to the 1.1.0 contract.
  for (const id of ['openai-gpt-image-2', 'seedream-4-0', 'seedream-4-5']) {
    assert.ok(cutover.includes(id))
  }
  for (const column of ['max_count', 'max_input_images', 'quality_options', 'vendor_model_id', 'model_kind']) {
    assert.ok(cutover.includes(column))
  }
  // The copied latest snapshot itself must agree: same plugin identity,
  // 1.0.0 version, preset vendor, and independently null-or-official base
  // URLs — never a COALESCE masked by the mutable model columns.
  for (const fragment of [
    'latest.plugin_id = m.plugin_id',
    "latest.plugin_version = '1.0.0'",
    'latest.vendor_model_id',
    'latest.base_url IS NULL',
    'r.vendor_model_id',
    'r.base_url IS NULL',
  ]) {
    assert.ok(cutover.includes(fragment))
  }
  assert.equal(cutover.includes('COALESCE(m.base_url'), false)
  // DALL-E-3 has no current preset and custom endpoints stay pinned to 1.0.0.
  assert.equal(cutover.includes('dall-e-3'), false)
  assert.ok(cutover.includes('https://api.openai.com'))
  assert.ok(cutover.includes('https://ark.cn-beijing.volces.com'))
  // Linked credentials must be absent or carry a null/official host.
  for (const fragment of [
    'LEFT JOIN provider_credentials cred',
    'latest.credential_id IS NULL',
    'r.credential_id IS NULL',
    'cred.base_url IS NULL',
  ]) {
    assert.ok(cutover.includes(fragment))
  }
  // The 1.1.0 snapshot is canonical: capabilities rebuilt from validated
  // columns, {} defaults, canonical normalized_config — never latest JSON.
  for (const fragment of [
    "'text_to_image'",
    "'reference_image'",
    "'{}'::jsonb",
    "'concurrencyLimit'",
    'canonical-v1',
  ]) {
    assert.ok(cutover.includes(fragment))
  }
  assert.equal(cutover.includes('latest.capabilities'), false)
  assert.equal(cutover.includes('latest.defaults'), false)
  assert.equal(cutover.includes('latest.pricing'), false)
  for (const fragment of ['per_image_v1', 'creditsPerImage', '9007199254740991', 'canonical-v1']) {
    assert.ok(cutover.includes(fragment))
  }
  // Host checks must apply to the currently linked credential: the copied
  // revision credential must equal the mutable model link.
  for (const fragment of [
    'latest.credential_id IS NOT DISTINCT FROM m.provider_credential_id',
    'r.credential_id IS NOT DISTINCT FROM m.provider_credential_id',
  ]) {
    assert.ok(cutover.includes(fragment))
  }
})

test('active image upsert validates fields and endpoint hosts against the plugin contract', async () => {
  const openai = globalProviderRegistry.get('openai-image', '1.1.0')
  const seedream = globalProviderRegistry.get('seedream-image', '1.1.0')
  assert.deepEqual(await validateImageModelContract(openai, {
    vendorModelId: 'gpt-image-2',
    sizes: ['1024x1024', '1280x720', '720x1280', '1536x1024', '1024x1536'],
    qualityOptions: ['auto', 'low', 'medium', 'high'],
    maxCount: 4,
    maxInputImages: 4,
  }), { ok: true })
  assert.equal((await validateImageModelContract(openai, {
    vendorModelId: 'gpt-image-2', sizes: ['9999x9999'], qualityOptions: [], maxCount: 1, maxInputImages: 0,
  })).ok, false)
  assert.equal((await validateImageModelContract(openai, {
    vendorModelId: 'gpt-image-2', sizes: ['1024x1024'], qualityOptions: ['ultra'], maxCount: 1, maxInputImages: 0,
  })).ok, false)
  assert.equal((await validateImageModelContract(openai, {
    vendorModelId: 'gpt-image-2', sizes: ['1024x1024'], qualityOptions: [], maxCount: 5, maxInputImages: 0,
  })).ok, false)
  assert.equal((await validateImageModelContract(openai, {
    vendorModelId: 'gpt-image-2', sizes: ['1024x1024'], qualityOptions: [], maxCount: 1, maxInputImages: 5,
  })).ok, false)
  assert.equal((await validateImageModelContract(openai, {
    vendorModelId: 'no-such-model', sizes: [], qualityOptions: [], maxCount: 1, maxInputImages: 0,
  })).ok, false)
  assert.deepEqual(await validateImageModelContract(seedream, {
    vendorModelId: 'doubao-seedream-4-5-251128',
    sizes: ['2048x2048'],
    qualityOptions: [],
    maxCount: 4,
    maxInputImages: 4,
  }), { ok: true })
  assert.equal((await validateImageModelContract(seedream, {
    vendorModelId: 'doubao-seedream-4-5-251128', sizes: ['1024x1024'], qualityOptions: [], maxCount: 1, maxInputImages: 0,
  })).ok, false)
  // DALL-E-3 declares maxInputImages 0: any reference image is rejected,
  // while zero passes the per-model cap.
  assert.deepEqual(await validateImageModelContract(openai, {
    vendorModelId: 'dall-e-3', sizes: ['1024x1024'], qualityOptions: ['standard'], maxCount: 1, maxInputImages: 0,
  }), { ok: true })
  assert.equal((await validateImageModelContract(openai, {
    vendorModelId: 'dall-e-3', sizes: ['1024x1024'], qualityOptions: ['standard'], maxCount: 1, maxInputImages: 1,
  })).ok, false)
  // Official endpoint hosts only; empty means the plugin default applies.
  assert.equal(imageBaseUrlAllowed('openai-image', 'https://api.openai.com'), true)
  assert.equal(imageBaseUrlAllowed('openai-image', null), true)
  assert.equal(imageBaseUrlAllowed('openai-image', 'https://proxy.example.com'), false)
  assert.equal(imageBaseUrlAllowed('seedream-image', 'https://ark.cn-beijing.volces.com'), true)
  assert.equal(imageBaseUrlAllowed('seedream-image', 'https://api.openai.com'), false)
  assert.equal(imageBaseUrlAllowed('openai-image', ''), true)
})
test('active image writes persist canonical capabilities and reject overrides', () => {
  const canonical = buildCanonicalImageCapabilities({
    sizes: ['1024x1024'],
    qualityOptions: [],
    maxCount: 2,
    maxInputImages: 0,
  })
  assert.deepEqual(canonical.modes, ['text_to_image'])
  assert.deepEqual(canonical.supportedMediaKinds, ['image'])
  assert.equal(canonical.mediaKind, 'image')
  assert.equal(canonical.maxCount, 2)
  const parameters = canonical.parameters as Record<string, unknown>[]
  assert.deepEqual(parameters.map((parameter) => parameter.name), ['size', 'count'])
  assert.deepEqual((parameters[0] as Record<string, unknown>).options, ['1024x1024'])
  assert.deepEqual(canonical.inputSlots, [])
  const withQuality = buildCanonicalImageCapabilities({
    sizes: ['1024x1024'],
    qualityOptions: ['auto'],
    maxCount: 4,
    maxInputImages: 3,
  })
  assert.deepEqual(withQuality.modes, ['text_to_image', 'image_to_image'])
  assert.deepEqual(withQuality.inputSlots, [
    { role: 'reference_image', required: false, minCount: 0, maxCount: 3, allowedMediaKinds: ['image'] },
  ])
  // Omitted fields are fine; any content is a rejectable override.
  for (const empty of [undefined, null, {}, [], '']) {
    assert.equal(isEmptyInputOverride(empty), true)
  }
  for (const override of [{ modes: [] }, { count: 1 }, ['size'], 'custom', 0]) {
    assert.equal(isEmptyInputOverride(override), false)
  }
})

test('active image upsert inspects the attached credential base URL', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, './modules/models/handlers.ts'), 'utf8')
  assert.ok(source.includes('SELECT id,base_url,provider_id,configured_fields FROM provider_credentials'))
})

test('credential schema versions stay positive safe integers', () => {
  assert.deepEqual(normalizeCredentialSchemaVersion(undefined), { ok: true, version: undefined })
  assert.deepEqual(normalizeCredentialSchemaVersion(undefined, 1), { ok: true, version: 1 })
  assert.deepEqual(normalizeCredentialSchemaVersion(2), { ok: true, version: 2 })
  assert.deepEqual(normalizeCredentialSchemaVersion('3'), { ok: true, version: 3 })
  for (const bad of [0, -1, 1.5, Number.NaN, 'abc', null]) {
    assert.deepEqual(normalizeCredentialSchemaVersion(bad), { ok: false })
  }
})

test('credential host or plugin redirects require a newly supplied secret', () => {
  const stored = { baseUrl: 'https://api.openai.com', pluginId: 'openai-image', pluginVersion: '1.1.0' }
  assert.equal(credentialTargetChanged(stored, { ...stored }), false)
  assert.equal(credentialTargetChanged(stored, { ...stored, baseUrl: 'https://proxy.example.com' }), true)
  assert.equal(credentialTargetChanged(stored, { ...stored, pluginId: 'seedream-image' }), true)
  assert.equal(credentialTargetChanged(stored, { ...stored, pluginVersion: '1.0.0' }), true)
  assert.equal(credentialTargetChanged({ baseUrl: null }, { baseUrl: '' }), false)
  assert.equal(credentialTargetChanged({ baseUrl: null }, { baseUrl: 'https://api.openai.com' }), true)
})

test('hardened 1.1.0 image manifests gate vendor models; custom IDs stay on 1.0.0', () => {
  const openaiModels = globalProviderRegistry.get('openai-image', '1.1.0').manifest.models || []
  const seedreamModels = globalProviderRegistry.get('seedream-image', '1.1.0').manifest.models || []
  assert.ok(openaiModels.length > 0)
  assert.ok(seedreamModels.length > 0)
  for (const id of ['gpt-image-2', 'dall-e-3']) {
    assert.equal(manifestSupportsVendorModel(openaiModels, id), true)
  }
  for (const id of ['doubao-seedream-4-0-250828', 'doubao-seedream-4-5-251128']) {
    assert.equal(manifestSupportsVendorModel(seedreamModels, id), true)
  }
  assert.equal(manifestSupportsVendorModel(openaiModels, 'my-custom-model'), false)
  assert.equal(manifestSupportsVendorModel(seedreamModels, 'gpt-image-2'), false)
  // An empty model list means the plugin accepts any vendor model ID.
  assert.equal(manifestSupportsVendorModel(undefined, 'anything'), true)
  assert.equal(manifestSupportsVendorModel([], 'anything'), true)
})

test('builtin provider templates expose exactly the four current plugins', () => {
  const templates = buildBuiltinProviderTemplates()
  assert.deepEqual(templates.map((template) => template.key), ['openai-image', 'seedream-image', 'seedance-video', 'veo-video'])
  const byKey = Object.fromEntries(templates.map((template) => [template.key, template]))
  assert.deepEqual(
    [byKey['openai-image'].pluginId, byKey['openai-image'].pluginVersion, byKey['openai-image'].providerId, byKey['openai-image'].adapter, byKey['openai-image'].modality, byKey['openai-image'].baseUrl],
    ['openai-image', '1.1.0', 'openai', 'openai', 'image', 'https://api.openai.com'],
  )
  assert.deepEqual(
    [byKey['seedream-image'].pluginId, byKey['seedream-image'].pluginVersion, byKey['seedream-image'].providerId, byKey['seedream-image'].adapter, byKey['seedream-image'].modality, byKey['seedream-image'].baseUrl],
    ['seedream-image', '1.1.0', 'volcengine', 'seedream', 'image', 'https://ark.cn-beijing.volces.com'],
  )
  assert.deepEqual(
    [byKey['seedance-video'].pluginId, byKey['seedance-video'].pluginVersion, byKey['seedance-video'].providerId, byKey['seedance-video'].adapter, byKey['seedance-video'].modality, byKey['seedance-video'].baseUrl],
    ['seedance-video', '1.0.0', 'volcengine', 'seedream', 'video', 'https://ark.cn-beijing.volces.com/api/v3'],
  )
  assert.deepEqual(
    [byKey['veo-video'].pluginId, byKey['veo-video'].pluginVersion, byKey['veo-video'].providerId, byKey['veo-video'].adapter, byKey['veo-video'].modality, byKey['veo-video'].baseUrl],
    ['veo-video', '1.0.0', 'google', 'veo', 'video', 'https://us-central1-aiplatform.googleapis.com'],
  )
  assert.deepEqual(byKey['openai-image'].credential, {
    schemaId: 'legacy-api-key-v1', schemaVersion: 1, kind: 'api_key',
    label: 'OpenAI API Key', placeholder: 'sk-...',
    helpText: 'Official OpenAI API key with image generation access.',
  })
  assert.equal(byKey['seedream-image'].credential.kind, 'api_key')
  assert.equal(byKey['seedance-video'].credential.kind, 'api_key')
  assert.deepEqual([byKey['veo-video'].credential.schemaId, byKey['veo-video'].credential.kind], ['json-v1', 'google_service_account'])
  // No legacy image versions leak into the catalog.
  for (const template of templates) {
    if (template.modality === 'image') assert.equal(template.pluginVersion, '1.1.0')
  }
  // Models and preset membership resolve from the exact manifests.
  for (const template of templates) {
    const manifest = globalProviderRegistry.get(template.pluginId, template.pluginVersion).manifest
    assert.deepEqual(template.models.map((model) => model.id), (manifest.models ?? []).map((model) => model.id))
    assert.ok(template.presetIds.length > 0)
  }
  assert.deepEqual([...byKey['openai-image'].presetIds].sort(), ['openai-gpt-image-2'])
  assert.deepEqual([...byKey['seedream-image'].presetIds].sort(), ['seedream-4-0', 'seedream-4-5'])
  assert.deepEqual(byKey['seedance-video'].presetIds, ['seedance-1-0'])
  assert.deepEqual(byKey['veo-video'].presetIds, ['veo-3-1'])
  for (const template of buildBuiltinProviderTemplates()) {
    const manifestIds = new Set((globalProviderRegistry.get(template.pluginId, template.pluginVersion).manifest.models ?? []).map((model) => model.id))
    for (const presetId of template.presetIds) {
      const preset = modelPresets.find((entry) => entry.id === presetId)
      assert.ok(preset && 'vendorModelId' in preset && manifestIds.has(preset.vendorModelId))
    }
  }
  // A stale vendor model ID fails loudly instead of serving a dead template.
  const stalePreset: VideoModelPreset = {
    id: 'stale-probe', modelKind: 'video', displayName: 'Stale', providerId: 'google',
    pluginId: 'veo-video', pluginVersion: '1.0.0', vendorModelId: 'veo-retired-preview',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com', modes: ['text_to_video'],
    parameters: [], inputSlots: [],
    pricing: { scheme: 'per_second_v1', creditsPerSecond: 20 },
    defaults: {}, maxCount: 1, concurrencyLimit: 1,
  }
  modelPresets.push(stalePreset)
  try {
    assert.throws(() => buildBuiltinProviderTemplates(), /absent from plugin/)
  } finally {
    modelPresets.pop()
  }
})

test('video presets use manifest-supported vendor models, official hosts, and provider-accurate parameters', () => {
  const seedance = modelPresets.find((preset) => preset.id === 'seedance-1-0')
  if (!seedance || seedance.modelKind !== 'video') throw new Error('seedance preset missing')
  assert.equal(seedance.vendorModelId, 'doubao-seedance-2-0-fast-260128')
  assert.equal(seedance.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3')
  const seedanceDuration = seedance.parameters.find((parameter) => parameter.name === 'durationSeconds')
  assert.deepEqual(seedanceDuration, { type: 'integer', name: 'durationSeconds', label: '时长（秒）', min: 1, max: 30, defaultValue: 5, required: false })
  assert.deepEqual(seedance.pricing, { scheme: 'per_second_v1', creditsPerSecond: 10, minDurationSeconds: 1, maxDurationSeconds: 30 })
  const veo = modelPresets.find((preset) => preset.id === 'veo-3-1')
  if (!veo || veo.modelKind !== 'video') throw new Error('veo preset missing')
  assert.equal(veo.vendorModelId, 'veo-3.1-generate-001')
  assert.equal(veo.baseUrl, 'https://us-central1-aiplatform.googleapis.com')
  // Enum strings so normalization can Number-convert them later.
  assert.deepEqual(
    veo.parameters.find((parameter) => parameter.name === 'durationSeconds'),
    { type: 'enum', name: 'durationSeconds', label: '时长（秒）', options: ['4', '6', '8'], defaultValue: '8', required: false },
  )
  assert.deepEqual(
    veo.parameters.find((parameter) => parameter.name === 'aspectRatio'),
    { type: 'enum', name: 'aspectRatio', label: '宽高比', options: ['16:9', '9:16'], defaultValue: '16:9', required: false },
  )
  assert.deepEqual(veo.pricing, { scheme: 'per_second_v1', creditsPerSecond: 20, minDurationSeconds: 4, maxDurationSeconds: 8 })
})

test('video presets become complete immutable revision contracts', () => {
  const veo = modelPresets.find((preset) => preset.id === 'veo-3-1')
  const contract = videoPresetRevisionContract(veo)
  assert.ok(contract)
  assert.deepEqual(contract.pricing, {
    scheme: 'per_second_v1',
    creditsPerSecond: 20,
    minDurationSeconds: 4,
    maxDurationSeconds: 8,
  })
  assert.deepEqual(contract.defaults, {
    durationSeconds: 8,
    aspectRatio: '16:9',
    resolution: '1080p',
    audio: true,
    count: 1,
  })
  assert.deepEqual(
    (contract.capabilities.parameters as Array<{ name: string }>).map((parameter) => parameter.name),
    ['durationSeconds', 'aspectRatio', 'resolution', 'audio', 'count'],
  )
  assert.deepEqual(contract.capabilities.supportedMediaKinds, ['video'])
})

test('model credentials require exact plugin identity with legacy provider fallback only', () => {
  const target = { providerId: 'google', pluginId: 'veo-video', pluginVersion: '1.0.0' }
  assert.equal(providerCredentialMatchesPluginTarget({
    provider_id: 'google',
    configured_fields: { pluginId: 'veo-video', pluginVersion: '1.0.0' },
  }, target), true)
  assert.equal(providerCredentialMatchesPluginTarget({
    provider_id: 'google',
    configured_fields: { pluginId: 'veo-video', pluginVersion: '2.0.0' },
  }, target), false)
  assert.equal(providerCredentialMatchesPluginTarget({
    provider_id: 'google',
    configured_fields: { pluginId: 'veo-video' },
  }, target), false)
  assert.equal(providerCredentialMatchesPluginTarget({
    provider_id: 'google',
    configured_fields: {},
  }, target), true)
  assert.equal(providerCredentialMatchesPluginTarget({
    provider_id: 'volcengine',
    configured_fields: {},
  }, target), false)
})

test('stored preset lookup never upgrades an explicitly pinned plugin version', () => {
  const preset = modelPresets.find((entry) => entry.id === 'openai-gpt-image-2')
  assert.ok(preset)
  assert.equal(presetMatchesPersistedModel(preset, {
    plugin_id: 'openai-image',
    plugin_version: '1.1.0',
    vendor_model_id: 'gpt-image-2',
  }), true)
  assert.equal(presetMatchesPersistedModel(preset, {
    plugin_id: 'openai-image',
    plugin_version: '1.0.0',
    vendor_model_id: 'gpt-image-2',
  }), false)
  assert.equal(presetMatchesPersistedModel(preset, {
    plugin_id: null,
    plugin_version: null,
    vendor_model_id: 'gpt-image-2',
  }), true)
})

test('admin provider templates route serves the registry-backed catalog', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '../app/api/[...path]/route.ts'), 'utf8')
  assert.ok(source.includes("admin/provider-templates"))
  assert.ok(source.includes('buildBuiltinProviderTemplates'))
})

test('explicit plugin credentials validate the plugin, schema, catalog metadata, and secret', async () => {
  const unknown = await validateExplicitPluginCredential({ pluginId: 'does-not-exist', pluginVersion: '9.9.9', secretPayload: 'sk-x' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.ok ? null : unknown.code, 'INVALID_PLUGIN')
  const undeclaredSchema = await validateExplicitPluginCredential({
    pluginId: 'veo-video', pluginVersion: '1.0.0', schemaId: 'legacy-api-key-v1', providerId: 'google', secretPayload: 'sk-x',
  })
  assert.equal(undeclaredSchema.ok, false)
  assert.equal(undeclaredSchema.ok ? null : undeclaredSchema.code, 'INVALID_INPUT')
  const malformedVeo = await validateExplicitPluginCredential({
    pluginId: 'veo-video', pluginVersion: '1.0.0', schemaId: 'json-v1', providerId: 'google', secretPayload: '{broken json',
  })
  assert.equal(malformedVeo.ok, false)
  assert.equal(malformedVeo.ok ? null : malformedVeo.code, 'INVALID_CREDENTIAL')
  const incompleteServiceAccount = await validateExplicitPluginCredential({
    pluginId: 'veo-video', pluginVersion: '1.0.0', schemaId: 'json-v1', providerId: 'google',
    secretPayload: JSON.stringify({ type: 'service_account', project_id: 'demo', client_email: 'veo@demo.iam.gserviceaccount.com' }),
  })
  assert.equal(incompleteServiceAccount.ok, false)
  assert.equal(incompleteServiceAccount.ok ? null : incompleteServiceAccount.code, 'INVALID_CREDENTIAL')
  const wrongProvider = await validateExplicitPluginCredential({
    pluginId: 'openai-image', pluginVersion: '1.1.0', providerId: 'volcengine', secretPayload: 'sk-test-key',
  })
  assert.equal(wrongProvider.ok, false)
  assert.equal(wrongProvider.ok ? null : wrongProvider.code, 'INVALID_INPUT')
  const wrongBaseUrl = await validateExplicitPluginCredential({
    pluginId: 'openai-image', pluginVersion: '1.1.0', providerId: 'openai',
    baseUrl: 'https://proxy.example.com', secretPayload: 'sk-test-key',
  })
  assert.equal(wrongBaseUrl.ok, false)
  assert.equal(wrongBaseUrl.ok ? null : wrongBaseUrl.code, 'INVALID_BASE_URL')
  // Built-in credentials resolve deterministically with catalog metadata.
  const openai = await validateExplicitPluginCredential({
    pluginId: 'openai-image', pluginVersion: '1.1.0', providerId: 'openai', secretPayload: 'sk-test-key-123',
  })
  assert.equal(openai.ok, true)
  if (openai.ok) {
    assert.deepEqual(
      [openai.pluginId, openai.pluginVersion, openai.schemaId, openai.schemaVersion, openai.baseUrl],
      ['openai-image', '1.1.0', 'legacy-api-key-v1', 1, 'https://api.openai.com'],
    )
  }
  const serviceAccount = JSON.stringify({
    type: 'service_account', project_id: 'demo-project',
    client_email: 'veo@demo-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  })
  const veo = await validateExplicitPluginCredential({
    pluginId: 'veo-video', pluginVersion: '1.0.0', schemaId: 'json-v1', providerId: 'google', secretPayload: serviceAccount,
  })
  assert.equal(veo.ok, true)
  if (veo.ok) {
    assert.deepEqual(
      [veo.pluginId, veo.pluginVersion, veo.schemaId, veo.baseUrl],
      ['veo-video', '1.0.0', 'json-v1', 'https://us-central1-aiplatform.googleapis.com'],
    )
  }
})

test('prompt template import validation enforces counts, names, variables, and braces', () => {
  const valid = validatePromptTemplateImport({
    templates: [
      { name: 'Photo', description: 'Photography', instruction: 'Draw {{input_prompt}} at {{size}}' },
      { name: 'Video', instruction: 'Animate {{input_prompt}}' },
    ],
  })
  assert.equal('input' in valid, true)
  if ('input' in valid) {
    assert.equal(valid.input.name, 'default')
    assert.equal(valid.input.activate, true)
    assert.equal(valid.input.templates[0].sortOrder, 0)
    assert.equal(valid.input.templates[1].sortOrder, 1)
  }
  const named = validatePromptTemplateImport({ name: 'custom', activate: false, templates: [{ name: 'A', instruction: 'Hi' }] })
  assert.equal('input' in named && named.input.name, 'custom')
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: [] }))?.code, 'INVALID_INPUT')
  const many = Array.from({ length: 101 }, (_, index) => ({ name: 'T' + index, instruction: 'Hi' }))
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: many }))?.code, 'INVALID_INPUT')
  assert.equal(asValidationError(validatePromptTemplateImport({}))?.code, 'INVALID_INPUT')
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: [{ name: '  ', instruction: 'Hi' }] }))?.code, 'TEMPLATE_NAME_EMPTY')
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: [{ name: 'A', instruction: '   ' }] }))?.code, 'TEMPLATE_INSTRUCTION_EMPTY')
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: [{ name: 'A', instruction: 'Hi {{unknown}}' }] }))?.code, 'INVALID_TEMPLATE_VARIABLE')
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: [{ name: 'A', instruction: 'Hi {{input_prompt' }] }))?.code, 'INVALID_INPUT')
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: [{ name: 'A', instruction: 'Hi }}' }] }))?.code, 'INVALID_INPUT')
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: [{ name: 'A', instruction: 'Hi' }, { name: 'A', instruction: 'Ho' }] }))?.code, 'DUPLICATE_TEMPLATE_NAME')
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: [{ name: 'A', description: 'x'.repeat(1001), instruction: 'Hi' }] }))?.code, 'INVALID_INPUT')
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: [{ name: 'A', instruction: 'Hi' + String.fromCharCode(0) }] }))?.code, 'INVALID_INPUT')
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: [{ name: 'A', instruction: 'x'.repeat(128 * 1024 + 1) }] }))?.code, 'INVALID_INPUT')
  assert.equal(asValidationError(validatePromptTemplateImport({ activate: 'yes', templates: [{ name: 'A', instruction: 'Hi' }] }))?.code, 'INVALID_INPUT')
  assert.equal(asValidationError(validatePromptTemplateImport({ templates: [{ name: 'A', instruction: 'Hi', sortOrder: 1000001 }] }))?.code, 'INVALID_INPUT')
  const maxSortImport = validatePromptTemplateImport({ templates: [{ name: 'A', instruction: 'Hi', sortOrder: 1000000 }] })
  assert.equal('input' in maxSortImport && maxSortImport.input.templates[0].sortOrder, 1000000)
})

test('prompt template entry patch validation requires at least one valid field', () => {
  assert.equal(asValidationError(validatePromptTemplateEntryPatch({}))?.code, 'INVALID_INPUT')
  assert.equal(asValidationError(validatePromptTemplateEntryPatch({ name: '' }))?.code, 'TEMPLATE_NAME_EMPTY')
  assert.equal(asValidationError(validatePromptTemplateEntryPatch({ instruction: 'Hi {{nope}}' }))?.code, 'INVALID_TEMPLATE_VARIABLE')
  assert.equal(asValidationError(validatePromptTemplateEntryPatch({ sortOrder: -1 }))?.code, 'INVALID_INPUT')
  assert.equal(asValidationError(validatePromptTemplateEntryPatch({ sortOrder: 1000001 }))?.code, 'INVALID_INPUT')
  const maxSortPatch = validatePromptTemplateEntryPatch({ sortOrder: 1000000 })
  assert.equal('patch' in maxSortPatch && maxSortPatch.patch.sortOrder, 1000000)
  const patched = validatePromptTemplateEntryPatch({ name: 'Renamed', sortOrder: 3 })
  assert.equal('patch' in patched && patched.patch.name, 'Renamed')
  assert.equal('patch' in patched && patched.patch.sortOrder, 3)
})

test('prompt template preview renders values and reports unresolved variables', () => {
  const rendered = renderPromptTemplatePreview('Draw {{input_prompt}} at {{size}}', { input_prompt: 'a tree' })
  assert.equal(rendered.rendered, 'Draw a tree at ')
  assert.deepEqual(rendered.usedVariables, ['input_prompt', 'size'])
  assert.equal(rendered.hasUnresolvedVariables, true)
  const complete = renderPromptTemplatePreview('Draw {{input_prompt}}', { input_prompt: 'x' })
  assert.equal(complete.hasUnresolvedVariables, false)
  assert.equal(asValidationError(validatePromptTemplatePreview({ instruction: 'Hi {{unknown}}' }))?.code, 'INVALID_TEMPLATE_VARIABLE')
  assert.equal(asValidationError(validatePromptTemplatePreview({ instruction: 'Hi', values: { unknown: 'x' } }))?.code, 'INVALID_TEMPLATE_VARIABLE')
  assert.equal(asValidationError(validatePromptTemplatePreview({ instruction: 'Hi', values: { count: { nested: true } } }))?.code, 'INVALID_INPUT')
  assert.equal(asValidationError(validatePromptTemplatePreview({ instruction: '' }))?.code, 'TEMPLATE_INSTRUCTION_EMPTY')
  assert.equal(asValidationError(validatePromptTemplatePreview({ instruction: 'Hi {{input_prompt' }))?.code, 'INVALID_INPUT')
})

test('prompt template digest is deterministic and covers description and instruction', () => {
  const first = computePromptTemplateDigest([{ name: 'A', description: 'one', instruction: 'Hi {{size}}' }])
  const second = computePromptTemplateDigest([{ name: 'A', description: 'one', instruction: 'Hi {{size}}' }])
  assert.equal(first, second)
  assert.equal(first.length, 64)
  assert.notEqual(first, computePromptTemplateDigest([{ name: 'A', description: 'one', instruction: 'Ho {{size}}' }]))
  assert.notEqual(first, computePromptTemplateDigest([{ name: 'A', description: 'two', instruction: 'Hi {{size}}' }]))
})

test('prompt template summary DTOs never leak instructions or resolved paths', () => {
  const summary = toPromptTemplateSetSummaryDto({
    id: 'set-1', name: 'default', version: 2, isActive: true, indexPath: 'db',
    entryCount: 1, contentDigest: 'abc', createdBy: 'user-1',
    createdAt: new Date('2026-09-03T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-09-03T00:00:00.000Z').toISOString(),
  })
  assert.equal(summary.createdBy, 'user-1')
  assert.ok(!('entries' in summary))
  assert.ok(!('instruction' in summary))
  assert.ok(!('resolvedPath' in summary))
})

test('prompt template export payload matches the downloadable standard shape', () => {
  const payload = buildPromptTemplateExportPayload({
    id: 'set-1', name: 'default', version: 3, isActive: true, indexPath: 'db',
    entryCount: 1, contentDigest: 'abc', createdBy: null,
    createdAt: new Date('2026-09-03T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-09-03T00:00:00.000Z').toISOString(),
    entries: [{
      id: 'entry-1', setId: 'set-1', name: 'Photo', description: 'd', path: 'Photo.md',
      contentSha256: 'sha', instruction: 'Draw {{input_prompt}}', sortOrder: 0,
      createdAt: new Date('2026-09-03T00:00:00.000Z').toISOString(),
    }],
  })
  assert.deepEqual(Object.keys(payload).sort(), ['name', 'templates', 'version'])
  assert.deepEqual(payload.templates, [{
    name: 'Photo', description: 'd', instruction: 'Draw {{input_prompt}}', path: 'Photo.md', sortOrder: 0,
  }])
  assert.equal('resolvedPath' in payload.templates[0], false)
  assert.equal(promptTemplateExportFilename('default', 3), 'prompt-templates-default-v3.json')
  assert.equal(promptTemplateExportFilename('../../etc Evil!', 2), 'prompt-templates-etc-evil-v2.json')
  assert.equal(isPromptTemplateSetId('not-a-uuid'), false)
  assert.equal(isPromptTemplateSetId('11111111-1111-4111-8111-111111111111'), true)
})

test('prompt template entry mutations fork a new version instead of mutating history', async () => {
  const queries: string[] = []
  let entrySeq = 100
  const setRow = (over: Record<string, unknown> = {}) => ({
    id: 'set-source', name: 'default', version: 3, is_active: true, index_path: 'db',
    entry_count: 1, content_digest: 'old', created_by: null,
    created_at: new Date('2026-09-03T00:00:00Z'), updated_at: new Date('2026-09-03T00:00:00Z'), ...over,
  })
  const entryRow = (over: Record<string, unknown> = {}) => ({
    id: 'entry-1', set_id: 'set-source', name: 'Photo', description: 'd', path: 'Photo.md',
    content_sha256: 'sha', instruction: 'Draw {{input_prompt}}', sort_order: 0,
    created_at: new Date('2026-09-03T00:00:00Z'), ...over,
  })
  const mockClient = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql)
      if (sql.includes('FROM prompt_template_sets WHERE id = $1 FOR UPDATE')) return { rows: [setRow()] }
      if (sql.includes('FROM prompt_template_sets WHERE id = $1')) return { rows: [setRow()] }
      if (sql.includes('FROM prompt_template_entries') && sql.includes('WHERE set_id')) return { rows: [entryRow()] }
      if (sql.includes('FROM prompt_template_entries') && sql.includes('WHERE id')) return { rows: [entryRow()] }
      if (sql.includes('COALESCE(MAX(version)')) return { rows: [{ v: 3 }] }
      if (sql.includes('INSERT INTO prompt_template_sets')) {
        return {
          rows: [setRow({
            id: 'set-new', version: params[1], is_active: false,
            entry_count: params[2], content_digest: params[3], created_by: params[4],
          })],
        }
      }
      if (sql.includes('INSERT INTO prompt_template_entries')) {
        entrySeq += 1
        return {
          rows: [entryRow({
            id: 'entry-new-' + entrySeq, set_id: 'set-new', name: params[1],
            description: params[2], path: params[3], content_sha256: params[4],
            instruction: params[5], sort_order: params[6],
          })],
        }
      }
      if (sql.includes('UPDATE onboarding_state')) return { rows: [{ config_revision: 8 }] }
      return { rows: [] }
    },
  } as unknown as pg.PoolClient
  const created = await createPromptTemplateEntry(mockClient, 'set-source', { name: 'New', instruction: 'Hi {{size}}' })
  assert.equal(created.version, 4)
  assert.equal(created.entries.length, 2)
  assert.ok(queries.some((sql) => sql.includes('pg_advisory_xact_lock')), 'fork must serialize version allocation with an advisory lock')
  assert.equal(created.isActive, true)
  assert.equal(created.contentDigest !== 'old', true)
  assert.ok(queries.some((sql) => sql.includes('INSERT INTO prompt_template_sets')))
  assert.equal(queries.some((sql) => sql.includes('UPDATE prompt_template_entries')), false)
  assert.equal(queries.some((sql) => sql.includes('DELETE FROM prompt_template_entries')), false)
  await assert.rejects(
    createPromptTemplateEntry(mockClient, 'set-source', { name: 'Photo', instruction: 'Hi' }),
    /DUPLICATE_TEMPLATE_NAME/,
  )
  await assert.rejects(
    createPromptTemplateEntry(mockClient, 'set-source', { name: 'Big', instruction: 'Hi', sortOrder: 1000001 }),
    /INVALID_INPUT/,
  )
  const updated = await updatePromptTemplateEntry(mockClient, 'entry-1', { instruction: 'Changed {{count}}' })
  assert.ok(updated)
  assert.equal(updated?.version, 4)
  assert.equal(updated?.entries.find((entry) => entry.id !== 'entry-1')?.instruction, 'Changed {{count}}')
  assert.equal(queries.some((sql) => sql.includes('UPDATE prompt_template_entries')), false)
  const missing = await updatePromptTemplateEntry(
    { query: async () => ({ rows: [] }) } as unknown as pg.PoolClient,
    '00000000-0000-4000-8000-000000000000',
    { instruction: 'Hi' },
  )
  assert.equal(missing, null)
})

test('prompt template set deletion rejects the active set and allows the rest', async () => {
  const activeRow = {
    id: 'set-active', name: 'default', version: 4, is_active: true, index_path: 'db',
    entry_count: 1, content_digest: 'd', created_by: null,
    created_at: new Date('2026-09-03T00:00:00Z'), updated_at: new Date('2026-09-03T00:00:00Z'),
  }
  const idleRow = { ...activeRow, id: 'set-idle', is_active: false }
  const seen: string[] = []
  const activeClient = {
    query: async (sql: string) => {
      seen.push(sql)
      if (sql.includes('FROM prompt_template_sets WHERE id')) return { rows: [activeRow] }
      return { rows: [] }
    },
  } as unknown as pg.PoolClient
  assert.deepEqual(await deletePromptTemplateSet(activeClient, 'set-active'), { deleted: false, error: 'CANNOT_DELETE_ACTIVE_SET' })
  assert.equal(seen.some((sql) => sql.includes('DELETE FROM prompt_template_sets')), false)
  assert.ok(seen.some((sql) => sql.includes('pg_advisory_xact_lock')), 'delete must serialize on the active advisory lock')
  const idleClient = {
    query: async (sql: string) => {
      if (sql.includes('FROM prompt_template_sets WHERE id')) return { rows: [idleRow] }
      return { rows: [] }
    },
  } as unknown as pg.PoolClient
  assert.deepEqual(await deletePromptTemplateSet(idleClient, 'set-idle'), { deleted: true })
  const goneClient = {
    query: async () => ({ rows: [] }),
  } as unknown as pg.PoolClient
  assert.deepEqual(await deletePromptTemplateSet(goneClient, '00000000-0000-4000-8000-000000000000'), { deleted: false, error: 'TEMPLATE_SET_NOT_FOUND' })
  const singleEntryClient = {
    query: async (sql: string) => {
      if (sql.includes('FROM prompt_template_entries WHERE id')) {
        return {
          rows: [{
            id: 'entry-1', set_id: 'set-source', name: 'Only', description: '', path: 'Only.md',
            content_sha256: 'sha', instruction: 'Hi', sort_order: 0,
            created_at: new Date('2026-09-03T00:00:00Z'),
          }],
        }
      }
      if (sql.includes('FROM prompt_template_sets')) {
        return {
          rows: [{
            id: 'set-source', name: 'default', version: 1, is_active: true, index_path: 'db',
            entry_count: 1, content_digest: 'd', created_by: null,
            created_at: new Date('2026-09-03T00:00:00Z'), updated_at: new Date('2026-09-03T00:00:00Z'),
          }],
        }
      }
      if (sql.includes('FROM prompt_template_entries') && sql.includes('WHERE set_id')) {
        return {
          rows: [{
            id: 'entry-1', set_id: 'set-source', name: 'Only', description: '', path: 'Only.md',
            content_sha256: 'sha', instruction: 'Hi', sort_order: 0,
            created_at: new Date('2026-09-03T00:00:00Z'),
          }],
        }
      }
      return { rows: [] }
    },
  } as unknown as pg.PoolClient
  await assert.rejects(deletePromptTemplateEntry(singleEntryClient, 'entry-1'), /INVALID_INPUT/)
})

test('prompt template validators reject null, array, and non-object inputs', () => {
  const badInputs: unknown[] = [null, undefined, [], 'templates', 42]
  for (const bad of badInputs) {
    assert.equal(asValidationError(validatePromptTemplateImport(bad))?.code, 'INVALID_INPUT')
    assert.equal(asValidationError(validatePromptTemplateEntryCreate(bad))?.code, 'INVALID_INPUT')
    assert.equal(asValidationError(validatePromptTemplateEntryPatch(bad))?.code, 'INVALID_INPUT')
    assert.equal(asValidationError(validatePromptTemplatePreview(bad))?.code, 'INVALID_INPUT')
  }
})
test('prompt template canonical routes replace the legacy file-index surface', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '../app/api/[...path]/route.ts'), 'utf8')
  for (const route of [
    'admin/prompt-templates',
    'admin/prompt-templates/sets',
    'admin/prompt-templates/export',
    'admin/prompt-templates/import',
    'admin/prompt-templates/preview',
    '/activate',
    'getAdminPromptTemplates',
    'listPromptTemplateSets',
    'getPromptTemplateSetDetail',
    'importPromptTemplates',
    'exportPromptTemplates',
    'activatePromptTemplateSet',
    'createPromptTemplateEntry',
    'updatePromptTemplateEntry',
    'deletePromptTemplateSet',
    'deletePromptTemplateEntry',
    'previewPromptTemplate',
  ]) {
    assert.ok(source.includes(route), 'missing route wiring: ' + route)
  }
  for (const legacy of [
    'createPromptTemplateEntryForSet',
    'updatePromptTemplateEntryById',
    'deletePromptTemplateSetById',
    'deletePromptTemplateEntryById',
    'getActivePromptTemplateSets',
    'listPromptTemplateSetSummaries',
    'importPromptTemplateSet(',
    'exportPromptTemplateSet(',
  ]) {
    assert.equal(source.includes(legacy), false, 'stale handler wiring: ' + legacy)
  }

  assert.equal(source.includes('prompt-templates/reload'), false)
  assert.equal(source.includes('loadPromptTemplateIndex'), false)
  assert.equal(source.includes('promptTemplateIndexDto'), false)
  const adminSource = readFileSync(join(here, './modules/admin/prompt-templates.ts'), 'utf8')
  assert.ok(adminSource.includes('Content-Disposition'))
  assert.ok(adminSource.includes('prompt_templates.import'))
  assert.ok(adminSource.includes('prompt_templates.activate'))
  assert.ok(adminSource.includes('prompt_templates.delete'))
  assert.ok(adminSource.includes('prompt_templates.entry_create'))
  assert.ok(adminSource.includes('prompt_templates.entry_update'))
  assert.ok(adminSource.includes('prompt_templates.entry_delete'))
  const setupSource = readFileSync(join(here, './modules/setup/handlers.ts'), 'utf8')
  assert.ok(setupSource.includes('createPromptTemplateSetWithEntries'))
  assert.ok(setupSource.includes("markOnboardingSection(client, 'templates', 'complete'"))
  assert.equal(setupSource.includes('INSERT INTO prompt_template_entries(set_id'), false)
  const migrateSource = readFileSync(join(here, '../../../packages/database/src/migrate.ts'), 'utf8')
  assert.ok(migrateSource.includes('prompt_template_sets_single_active_idx'))
  assert.ok(migrateSource.includes('WHERE is_active'))
  const repoSource = readFileSync(join(here, '../../../packages/database/src/repositories/prompt-templates.ts'), 'utf8')
  assert.ok(repoSource.includes('pg_advisory_xact_lock'))
})

test('prompt template entry mutations reject inactive sources and bound sort orders', async () => {
  const inactiveSet = {
    id: 'set-idle', name: 'default', version: 2, is_active: false, index_path: 'db',
    entry_count: 1, content_digest: 'd', created_by: null,
    created_at: new Date('2026-09-03T00:00:00Z'), updated_at: new Date('2026-09-03T00:00:00Z'),
  }
  const idleEntry = {
    id: 'entry-idle', set_id: 'set-idle', name: 'Photo', description: '', path: 'Photo.md',
    content_sha256: 'sha', instruction: 'Hi', sort_order: 0,
    created_at: new Date('2026-09-03T00:00:00Z'),
  }
  const idleClient = {
    query: async (sql: string) => {
      if (sql.includes('FROM prompt_template_entries') && sql.includes('WHERE id')) return { rows: [idleEntry] }
      if (sql.includes('FROM prompt_template_sets')) return { rows: [inactiveSet] }
      if (sql.includes('FROM prompt_template_entries') && sql.includes('WHERE set_id')) return { rows: [idleEntry] }
      if (sql.includes('COALESCE(MAX(version)')) return { rows: [{ v: 2 }] }
      return { rows: [] }
    },
  } as unknown as pg.PoolClient
  await assert.rejects(createPromptTemplateEntry(idleClient, 'set-idle', { name: 'New', instruction: 'Hi' }), /TEMPLATE_SET_NOT_ACTIVE/)
  await assert.rejects(updatePromptTemplateEntry(idleClient, 'entry-idle', { instruction: 'Hi' }), /TEMPLATE_SET_NOT_ACTIVE/)
  await assert.rejects(deletePromptTemplateEntry(idleClient, 'entry-idle'), /TEMPLATE_SET_NOT_ACTIVE/)
  await assert.rejects(
    createPromptTemplateEntry(idleClient, 'set-idle', { name: 'New', instruction: 'Hi', sortOrder: 1000001 }),
    /TEMPLATE_SET_NOT_ACTIVE/,
  )
})

test('setup template import enforces the 1 to 100 entry bound', () => {
  const one = validateSetupTemplateImport({ templates: [{ name: 'A', instruction: 'Hi' }] })
  assert.equal(Array.isArray(one) && one.length, 1)
  assert.deepEqual(validateSetupTemplateImport(null), { code: 'INVALID_INPUT', message: '模板列表无效' })
  assert.deepEqual(validateSetupTemplateImport({ templates: [] }), { code: 'INVALID_INPUT', message: '模板数量必须在 1 到 100 之间' })
  const many = Array.from({ length: 101 }, (_, index) => ({ name: 'T' + index, instruction: 'Hi' }))
  assert.deepEqual(validateSetupTemplateImport({ templates: many }), { code: 'INVALID_INPUT', message: '模板数量必须在 1 到 100 之间' })
})
