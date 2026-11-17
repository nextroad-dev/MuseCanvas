import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_MEDIA_EVENT_STREAM, AGENT_STREAM, GENERATION_STREAM, OUTBOX_EVENT_TYPES, routeOutboxEvent } from './outbox-routing'

const event = (event_type: string, payload: unknown, aggregate_id = 'job-1') => ({ id: 'event-1', event_type, aggregate_id, payload })

test('all existing generation producers retain generation stream fields', () => {
  const generationTypes = [OUTBOX_EVENT_TYPES.generationRequested, OUTBOX_EVENT_TYPES.generationCancelRequested, OUTBOX_EVENT_TYPES.generationRetryManual, OUTBOX_EVENT_TYPES.generationRetry]
  for (const type of generationTypes) assert.deepEqual(routeOutboxEvent(event(type, { jobId: 'job-2' })), { kind: 'publish', stream: GENERATION_STREAM, fields: { jobId: 'job-2', runId: '', eventId: 'event-1' } })
  for (const type of [OUTBOX_EVENT_TYPES.providerRunPoll, OUTBOX_EVENT_TYPES.providerRunCancel]) {
    assert.deepEqual(routeOutboxEvent(event(type, { jobId: 'job-2', runId: 'run-3' })), { kind: 'publish', stream: GENERATION_STREAM, fields: { jobId: 'job-2', runId: 'run-3', eventId: 'event-1' } })
    assert.deepEqual(routeOutboxEvent(event(type, { jobId: 'job-2' })), { kind: 'quarantine', code: 'INVALID_PAYLOAD' })
  }
  assert.deepEqual(routeOutboxEvent(event(OUTBOX_EVENT_TYPES.generationRequested, {}, 'fallback-job')).kind, 'publish')
  assert.deepEqual(routeOutboxEvent(event(OUTBOX_EVENT_TYPES.generationRequested, { jobId: { unsafe: true } })).kind, 'quarantine')
})

test('Agent commands route independently and unknown/malformed events are quarantinable', () => {
  assert.deepEqual(routeOutboxEvent(event(OUTBOX_EVENT_TYPES.agentTurnWake, { schemaVersion: 1, sessionId: 's', turnId: 't', revision: '9223372036854775807' })), {
    kind: 'publish', stream: AGENT_STREAM, fields: { eventId: 'event-1', aggregateId: 'job-1', schemaVersion: '1', sessionId: 's', turnId: 't', revision: '9223372036854775807' },
  })
  assert.deepEqual(routeOutboxEvent(event(OUTBOX_EVENT_TYPES.mediaJobCompleted, { schemaVersion: 1, jobId: 'j' })), {
    kind: 'publish', stream: AGENT_MEDIA_EVENT_STREAM, fields: { eventId: 'event-1', aggregateId: 'job-1', schemaVersion: '1', jobId: 'j' },
  })
  assert.deepEqual(routeOutboxEvent(event(OUTBOX_EVENT_TYPES.agentTurnWake, [])), { kind: 'quarantine', code: 'INVALID_PAYLOAD' })
  assert.deepEqual(routeOutboxEvent(event('surprise.event', {})), { kind: 'quarantine', code: 'UNKNOWN_EVENT_TYPE' })
})
