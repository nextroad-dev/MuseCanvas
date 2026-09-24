import test from 'node:test'
import assert from 'node:assert/strict'
import { languageErrorToNormalizedCode } from './index'

test('languageErrorToNormalizedCode maps legacy language codes to normalized provider codes', () => {
  assert.equal(
    languageErrorToNormalizedCode('PROMPT_OPTIMIZATION_TEMPORARY_ERROR'),
    'PROVIDER_TEMPORARY_ERROR',
  )
  assert.equal(
    languageErrorToNormalizedCode('PROMPT_OPTIMIZATION_REJECTED'),
    'PROVIDER_REJECTED',
  )
})
