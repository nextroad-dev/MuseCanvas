import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  beginConfirmation,
  classifyConfirmError,
  confirmationFailed,
  confirmationFor,
  confirmationSucceeded,
  createConfirmationState,
  isConfirmationBusy,
} from './agent-confirmation.ts'

function confirmResult(status, extra = {}) {
  return { pending: { id: 'p1', status, jobId: null, ...extra }, ops: [], jobId: extra.jobId ?? null }
}

test('confirm: idle -> submitting -> submitted, reconciling the returned snapshot', () => {
  let map = createConfirmationState()
  assert.equal(confirmationFor(map, 'p1').phase, 'idle')
  assert.equal(isConfirmationBusy(map, 'p1'), false)

  map = beginConfirmation(map, 'p1', 'confirm')
  assert.equal(confirmationFor(map, 'p1').phase, 'submitting')
  assert.equal(confirmationFor(map, 'p1').action, 'confirm')
  assert.equal(isConfirmationBusy(map, 'p1'), true)

  map = confirmationSucceeded(map, confirmResult('submitted', { jobId: 'job-1' }))
  assert.equal(confirmationFor(map, 'p1').phase, 'submitted')
  assert.equal(isConfirmationBusy(map, 'p1'), false)
  assert.equal(confirmationFor(map, 'p1').message, null)
})

test('reject: idle -> submitting -> rejected', () => {
  let map = beginConfirmation(createConfirmationState(), 'p1', 'reject')
  assert.equal(confirmationFor(map, 'p1').action, 'reject')
  map = confirmationSucceeded(map, confirmResult('rejected'))
  assert.equal(confirmationFor(map, 'p1').phase, 'rejected')
})

test('a 409 conflict requires a new proposal and never a retry of the stale pending', () => {
  let map = beginConfirmation(createConfirmationState(), 'p1', 'confirm')
  map = confirmationFailed(map, 'p1', { code: 'CANVAS_AGENT_CONFIRM_CONFLICT', message: 'stale' })
  const confirmation = confirmationFor(map, 'p1')
  assert.equal(confirmation.phase, 'conflict')
  assert.equal(confirmation.requiresNewProposal, true)
  assert.equal(isConfirmationBusy(map, 'p1'), false)
  assert.match(confirmation.message, /新的请求/)
})

test('expired and not-found proposals also require a new proposal', () => {
  const expired = confirmationFailed(createConfirmationState(), 'p1', { code: 'CANVAS_AGENT_CONFIRM_EXPIRED' })
  assert.equal(confirmationFor(expired, 'p1').phase, 'expired')
  assert.equal(confirmationFor(expired, 'p1').requiresNewProposal, true)

  const missing = confirmationFailed(createConfirmationState(), 'p1', { code: 'CANVAS_AGENT_CONFIRM_NOT_FOUND' })
  assert.equal(confirmationFor(missing, 'p1').phase, 'expired')
  assert.equal(confirmationFor(missing, 'p1').requiresNewProposal, true)
})

test('a transient failure stays retryable: it reports the real reason without forcing a new proposal', () => {
  let map = beginConfirmation(createConfirmationState(), 'p1', 'reject')
  map = confirmationFailed(map, 'p1', new Error('network down'))
  const confirmation = confirmationFor(map, 'p1')
  assert.equal(confirmation.phase, 'error')
  assert.equal(confirmation.requiresNewProposal, false)
  assert.match(confirmation.message, /network down/)
})

test('error classification maps the documented status codes and falls back for the rest', () => {
  assert.equal(classifyConfirmError({ code: 'CANVAS_AGENT_CONFIRM_CONFLICT' }).phase, 'conflict')
  assert.equal(classifyConfirmError({ code: 'CANVAS_AGENT_CONFIRM_EXPIRED' }).phase, 'expired')
  assert.equal(classifyConfirmError({ code: 'CANVAS_AGENT_CONFIRM_NOT_FOUND' }).requiresNewProposal, true)
  assert.equal(classifyConfirmError({ code: 'HTTP_500', message: 'upstream' }).phase, 'error')
  assert.equal(classifyConfirmError({ code: 'HTTP_500', message: 'upstream' }).message, 'upstream')
  assert.equal(classifyConfirmError(null).phase, 'error')
})

test('confirmations are tracked per pending id, so one card never leaks into another', () => {
  let map = createConfirmationState()
  map = beginConfirmation(map, 'p1', 'confirm')
  assert.equal(confirmationFor(map, 'p1').phase, 'submitting')
  assert.equal(confirmationFor(map, 'p2').phase, 'idle')
})
