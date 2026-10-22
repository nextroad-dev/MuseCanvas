import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveClaimRequired } from './claim-required'

test('the claim is required when SETUP_CLAIM_REQUIRED is unset, empty or true', () => {
  assert.equal(resolveClaimRequired({}), true)
  assert.equal(resolveClaimRequired({ SETUP_CLAIM_REQUIRED: '' }), true)
  assert.equal(resolveClaimRequired({ SETUP_CLAIM_REQUIRED: '   ' }), true)
  assert.equal(resolveClaimRequired({ SETUP_CLAIM_REQUIRED: 'true' }), true)
  assert.equal(resolveClaimRequired({ SETUP_CLAIM_REQUIRED: 'TRUE' }), true)
})

test('only exactly false (case-insensitive, trimmed) turns the claim off', () => {
  assert.equal(resolveClaimRequired({ SETUP_CLAIM_REQUIRED: 'false' }), false)
  assert.equal(resolveClaimRequired({ SETUP_CLAIM_REQUIRED: 'FALSE' }), false)
  assert.equal(resolveClaimRequired({ SETUP_CLAIM_REQUIRED: ' False ' }), false)
})

test('any other value fails safe to required', () => {
  for (const raw of ['no', '0', 'off', 'disabled', 'fals', 'falsey', 'false1', 'yes', 'garbage']) {
    assert.equal(resolveClaimRequired({ SETUP_CLAIM_REQUIRED: raw }), true, raw)
  }
})
