import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildContinuationRequest, shouldContinuePlanning } from './agent-continuation.ts'

const base = {
  optIn: false,
  explicitClick: false,
  jobStatus: 'succeeded',
  alreadyContinued: false,
  streaming: false,
  agentCanGenerate: true,
}

test('continuation defaults off: without a click or the opt-in nothing is sent', () => {
  assert.equal(shouldContinuePlanning(base), false)
  assert.equal(shouldContinuePlanning({ ...base, optIn: false, explicitClick: false, jobStatus: 'succeeded' }), false)
})

test('an explicit click continues a succeeded job (even one already continued)', () => {
  assert.equal(shouldContinuePlanning({ ...base, explicitClick: true }), true)
  assert.equal(shouldContinuePlanning({ ...base, explicitClick: true, alreadyContinued: true }), true)
})

test('the opt-in fires once per job and only after a successful result', () => {
  const opted = { ...base, optIn: true }
  assert.equal(shouldContinuePlanning(opted), true)
  assert.equal(shouldContinuePlanning({ ...opted, alreadyContinued: true }), false)
  assert.equal(shouldContinuePlanning({ ...opted, jobStatus: 'running' }), false)
  assert.equal(shouldContinuePlanning({ ...opted, jobStatus: 'queued' }), false)
  assert.equal(shouldContinuePlanning({ ...opted, jobStatus: 'failed' }), false)
  assert.equal(shouldContinuePlanning({ ...opted, jobStatus: 'canceled' }), false)
  assert.equal(shouldContinuePlanning({ ...opted, jobStatus: null }), false)
})

test('a streaming turn or an unavailable Agent blocks continuation even when opted in', () => {
  assert.equal(shouldContinuePlanning({ ...base, optIn: true, streaming: true }), false)
  assert.equal(shouldContinuePlanning({ ...base, optIn: true, agentCanGenerate: false }), false)
  assert.equal(shouldContinuePlanning({ ...base, explicitClick: true, agentCanGenerate: false }), false)
})

test('the continuation request is a job_event with agent-managed commit and no structured context', () => {
  const request = buildContinuationRequest({ messageId: 'm', jobId: 'j', baseRevision: 7 })
  assert.deepEqual(request, {
    kind: 'job_event',
    messageId: 'm',
    jobId: 'j',
    baseRevision: 7,
    sceneCommitMode: 'agent-managed',
  })
  assert.equal('context' in request, false)
})
