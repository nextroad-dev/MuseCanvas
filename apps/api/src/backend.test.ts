import assert from 'node:assert/strict'
import test from 'node:test'
import { validateModelInput } from '../../../packages/domain/src/index'
import { decryptSecret, encryptSecret, hashOtp, safeEqual } from './security'
import { adminJobDto } from './dto'
import { providerEndpoint } from '../../../packages/providers/src/index'

process.env.SESSION_SECRET = 'test-session-secret-with-enough-entropy'
process.env.SMTP_ENCRYPTION_KEY = 'test-encryption-key-with-enough-entropy'

test('OTP hashes are scoped to the email and compare in constant time', () => {
  const hash = hashOtp('one@example.com', '123456')
  assert.equal(safeEqual(hash, hashOtp('one@example.com', '123456')), true)
  assert.equal(safeEqual(hash, hashOtp('two@example.com', '123456')), false)
})

test('SMTP credentials round-trip through authenticated encryption', () => {
  const encrypted = encryptSecret('smtp-password')
  assert.notEqual(encrypted, 'smtp-password')
  assert.equal(decryptSecret(encrypted), 'smtp-password')
})

test('model input is limited to configured capabilities', () => {
  const model = { adapter: 'openai', sizes: ['1024x1024'], qualityOptions: ['medium'], maxCount: 2 }
  assert.equal(validateModelInput(model, { size: '1024x1024', quality: 'medium', count: 2 }), null)
  assert.equal(validateModelInput(model, { size: '4K', quality: 'medium', count: 1 }), 'INVALID_SIZE')
  assert.equal(validateModelInput(model, { size: '1024x1024', quality: 'high', count: 1 }), 'INVALID_QUALITY')
  assert.equal(validateModelInput(model, { size: '1024x1024', quality: 'medium', count: 3 }), 'INVALID_COUNT')
})

test('admin job diagnostics exclude prompts, objects, and image data', () => {
  const dto = adminJobDto({
    id: 'job-id', created_by: 'user-id', model_id: 'model-id', model_name: 'Model', status: 'failed', error_code: 'SAFE_ERROR',
    provider_reference_id: 'provider-ref', created_at: new Date('2026-01-01T00:00:00Z'), started_at: new Date('2026-01-01T00:00:00Z'), completed_at: new Date('2026-01-01T00:00:01Z'),
    prompt: 'must-not-leak', object_key: 'must-not-leak', image_url: 'must-not-leak',
  })
  assert.equal(dto.durationMs, 1000)
  const serialized = JSON.stringify(dto)
  assert.equal(serialized.includes('must-not-leak'), false)
  assert.equal('prompt' in dto, false)
})

test('provider endpoints accept service roots and versioned compatible roots', () => {
  assert.equal(providerEndpoint('openai', 'https://proxy.example.com'), 'https://proxy.example.com/v1/images/generations')
  assert.equal(providerEndpoint('openai', 'https://proxy.example.com/openai/v1'), 'https://proxy.example.com/openai/v1/images/generations')
  assert.equal(providerEndpoint('seedream', 'https://ark.example.com'), 'https://ark.example.com/api/v3/images/generations')
  assert.equal(providerEndpoint('seedream', 'https://ark.example.com/api/v3'), 'https://ark.example.com/api/v3/images/generations')
})
