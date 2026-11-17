export const GENERATION_STREAM = 'muse:generation'
export const AGENT_STREAM = 'muse:agent'
export const AGENT_MEDIA_EVENT_STREAM = 'muse:agent-media-events'
export const OUTBOX_EVENT_TYPES = {
  generationRequested: 'generation.requested',
  generationCancelRequested: 'generation.cancel.requested',
  generationRetryManual: 'generation.retry.manual',
  generationRetry: 'generation.retry',
  providerRunPoll: 'provider_run.poll',
  providerRunCancel: 'provider_run.cancel',
  agentTurnWake: 'agent.turn.wake',
  mediaJobCompleted: 'media.job.completed',
} as const

export interface ClaimedOutboxEvent {
  id: string
  aggregate_id: string
  event_type: string
  payload: unknown
}
export type OutboxRoute =
  | { kind: 'publish'; stream: string; fields: Record<string, string> }
  | { kind: 'quarantine'; code: 'UNKNOWN_EVENT_TYPE' | 'INVALID_PAYLOAD' }

function objectPayload(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}
function stringField(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Explicit producer allowlist; never coerce arbitrary payload values into job IDs. */
export function routeOutboxEvent(event: ClaimedOutboxEvent): OutboxRoute {
  const payload = objectPayload(event.payload)
  if (!payload) return { kind: 'quarantine', code: 'INVALID_PAYLOAD' }
  if (payload.jobId !== undefined && !stringField(payload, 'jobId')) return { kind: 'quarantine', code: 'INVALID_PAYLOAD' }
  const jobId = stringField(payload, 'jobId') ?? event.aggregate_id
  switch (event.event_type) {
    case OUTBOX_EVENT_TYPES.generationRequested:
    case OUTBOX_EVENT_TYPES.generationCancelRequested:
    case OUTBOX_EVENT_TYPES.generationRetryManual:
    case OUTBOX_EVENT_TYPES.generationRetry: {
      if (!jobId) return { kind: 'quarantine', code: 'INVALID_PAYLOAD' }
      return { kind: 'publish', stream: GENERATION_STREAM, fields: { jobId, runId: '', eventId: event.id } }
    }
    case OUTBOX_EVENT_TYPES.providerRunPoll:
    case OUTBOX_EVENT_TYPES.providerRunCancel: {
      const runId = stringField(payload, 'runId')
      if (!jobId || !runId) return { kind: 'quarantine', code: 'INVALID_PAYLOAD' }
      return { kind: 'publish', stream: GENERATION_STREAM, fields: { jobId, runId, eventId: event.id } }
    }
    case OUTBOX_EVENT_TYPES.agentTurnWake: {
      const sessionId = stringField(payload, 'sessionId')
      const turnId = stringField(payload, 'turnId')
      const revision = payload.revision
      if (payload.schemaVersion !== 1 || !sessionId || !turnId || typeof revision !== 'string' || !/^[1-9]\d*$/.test(revision)) return { kind: 'quarantine', code: 'INVALID_PAYLOAD' }
      return { kind: 'publish', stream: AGENT_STREAM, fields: { eventId: event.id, aggregateId: event.aggregate_id, schemaVersion: '1', sessionId, turnId, revision } }
    }
    case OUTBOX_EVENT_TYPES.mediaJobCompleted:
      if (payload.schemaVersion !== 1 || !stringField(payload, 'jobId')) return { kind: 'quarantine', code: 'INVALID_PAYLOAD' }
      return { kind: 'publish', stream: AGENT_MEDIA_EVENT_STREAM, fields: { eventId: event.id, aggregateId: event.aggregate_id, schemaVersion: '1', jobId: payload.jobId as string } }
    default:
      return { kind: 'quarantine', code: 'UNKNOWN_EVENT_TYPE' }
  }
}

