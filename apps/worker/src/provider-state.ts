import { createHash } from 'node:crypto'
import { decryptApiKey, encryptApiKey } from '../../../packages/providers/src/index'
import type { OutputDescriptor } from '../../../packages/providers/src/index'

export const PROVIDER_LEASE_SECONDS = 60
export const SUBMISSION_UNKNOWN_DELAY_MS = 15_000
export const DEFAULT_POLL_DELAY_MS = 5_000
export const MAX_POLL_DELAY_MS = 600_000

const NON_TERMINAL_RUN_STATES = new Set([
  'submitting',
  'submission_unknown',
  'waiting',
  'importing',
  'canceling',
])

export function isNonTerminalRunState(state: string | null | undefined): boolean {
  return state != null && NON_TERMINAL_RUN_STATES.has(state)
}

/** A new provider run is needed only when there is no run or the latest is terminal. */
export function shouldCreateNewRun(latestState: string | null | undefined): boolean {
  return !isNonTerminalRunState(latestState)
}

export function encryptOpaqueState(state: Record<string, unknown> | undefined): string | null {
  if (!state || Object.keys(state).length === 0) return null
  return encryptApiKey(JSON.stringify(state))
}

export function decryptOpaqueState(payload: string | null | undefined): Record<string, unknown> | undefined {
  if (!payload) return undefined
  try {
    const raw = decryptApiKey(payload)
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}

export type StrippedOutputEntry = {
  index: number
  mimeType: string
  width?: number
  height?: number
  durationSeconds?: number
  sizeBytes?: number
  metadata?: Record<string, unknown>
}

/**
 * Build an output manifest safe for plaintext DB storage: drops signed
 * remote URLs and inline base64 payloads, keeping only descriptive fields.
 * The locator needed to fetch bytes stays in encrypted provider state.
 */
export function stripOutputManifest(outputs: OutputDescriptor[] | undefined | null): StrippedOutputEntry[] | null {
  if (!outputs || outputs.length === 0) return null
  return outputs.map(desc => {
    const entry: StrippedOutputEntry = { index: desc.index, mimeType: desc.mimeType }
    if (desc.width !== undefined) entry.width = desc.width
    if (desc.height !== undefined) entry.height = desc.height
    if (desc.durationSeconds !== undefined) entry.durationSeconds = desc.durationSeconds
    if (desc.sizeBytes !== undefined) entry.sizeBytes = desc.sizeBytes
    if (desc.metadata && typeof desc.metadata === 'object') {
      const cleaned: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(desc.metadata)) {
        if (typeof value === 'string' && /^https?:\/\//.test(value)) continue
        cleaned[key] = value
      }
      if (Object.keys(cleaned).length > 0) entry.metadata = cleaned
    }
    return entry
  })
}

export function manifestContainsSecrets(manifest: unknown): boolean {
  if (!manifest) return false
  const text = JSON.stringify(manifest)
  return /https?:\/\/|b64Json|signed|sas_token|sig=|seckey|api[_-]?key/i.test(text)
}

export function nextActionAtForRetryAfter(retryAfterMs: number | undefined, fallbackMs = DEFAULT_POLL_DELAY_MS): Date {
  const raw = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : fallbackMs
  const clamped = Math.min(Math.max(Math.round(raw), 1000), MAX_POLL_DELAY_MS)
  return new Date(Date.now() + clamped)
}

export function submissionUnknownNextActionAt(): Date {
  return new Date(Date.now() + SUBMISSION_UNKNOWN_DELAY_MS)
}

const TRANSIENT_CODES = new Set([
  'PROVIDER_TEMPORARY_ERROR',
  'PROVIDER_TIMEOUT',
  'PROVIDER_DOWNLOAD_FAILED',
  'PROVIDER_BUSY',
  'INPUT_IMAGE_UNAVAILABLE',
  'STORAGE_TEMPORARY_ERROR',
  'PROMPT_OPTIMIZATION_TEMPORARY_ERROR',
  'LANGUAGE_MODEL_RESPONSE_INVALID',
  'PROVIDER_EMPTY_RESULT',
])

export function isTransientErrorCode(code: string | undefined | null): boolean {
  return !!code && TRANSIENT_CODES.has(code)
}

export const MAX_SYNC_SUBMIT_ATTEMPTS = 3
export const SYNC_RETRY_OUTBOX_EVENT_TYPE = 'generation.retry'
export const SYNC_RETRYABLE_HTTP_STATUS = 429
export const MAX_RESOLVED_OUTPUT_BYTES = 100_000_000

export type SyncRetryDiagnostic = { status?: unknown; code?: unknown } | null | undefined

/**
 * Synchronous image plugins have no provider-guaranteed idempotency key, so
 * an automatic resubmit is only safe for explicit HTTP 429 diagnostics
 * (known non-acceptance: nothing was charged or created). Timeouts,
 * transport errors, and 5xx TEMPORARY_ERRORs may have been accepted
 * provider-side and must terminate/release instead of resubmitting.
 */
export function isSyncRetryableSubmitCode(
  code: string | undefined | null,
  diagnostic?: SyncRetryDiagnostic,
): boolean {
  if (code !== 'PROVIDER_TEMPORARY_ERROR') return false
  if (!diagnostic || typeof diagnostic !== 'object') return false
  return 'status' in diagnostic && diagnostic.status === SYNC_RETRYABLE_HTTP_STATUS
}

/**
 * Bounded retry for synchronous plugins: retry while attempts remain.
 * Attempt is the 1-based generation_jobs.attempt already incremented at claim,
 * so attempt >= maxAttempts is terminal.
 */
export function shouldRetrySyncSubmit(
  attempt: number,
  code: string | undefined | null,
  diagnostic?: SyncRetryDiagnostic,
  maxAttempts: number = MAX_SYNC_SUBMIT_ATTEMPTS,
): boolean {
  return (
    Number.isSafeInteger(attempt) &&
    attempt >= 1 &&
    attempt < maxAttempts &&
    isSyncRetryableSubmitCode(code, diagnostic)
  )
}

export interface SyncSubmitRetryPlan {
  retry: boolean
  runOperationState: 'failed'
  releaseCapacity: boolean
  completeRun: boolean
  jobStatus: 'retry_wait' | 'failed'
  outboxEventType: 'generation.retry' | null
}

/**
 * Disposition for a failed synchronous submit: close and release the current
 * run in both cases; retry enqueues a new outbox submission via retry_wait,
 * exhaustion becomes terminal failed.
 */
export function planSyncSubmitRetry(
  attempt: number,
  code: string | undefined | null,
  diagnostic?: SyncRetryDiagnostic,
  maxAttempts: number = MAX_SYNC_SUBMIT_ATTEMPTS,
): SyncSubmitRetryPlan {
  const retry = shouldRetrySyncSubmit(attempt, code, diagnostic, maxAttempts)
  return {
    retry,
    runOperationState: 'failed',
    releaseCapacity: true,
    completeRun: true,
    jobStatus: retry ? 'retry_wait' : 'failed',
    outboxEventType: retry ? SYNC_RETRY_OUTBOX_EVENT_TYPE : null,
  }
}

export function isSyncRetryableResultError(result: { status?: unknown; error?: { code?: unknown; status?: unknown } } | null | undefined): boolean {
  if (result?.status !== 'failed' || !result?.error || typeof result.error !== 'object') return false
  if (!('code' in result.error) || typeof result.error.code !== 'string') return false
  return isSyncRetryableSubmitCode(result.error.code, result.error)
}

/**
 * Recovery classification for a synchronous run that reaches poll without a
 * remote id. A run still in submitting never completed its inline submit
 * (crash or failed retry persistence before any provider acceptance), so
 * redelivery must not blindly resubmit without provider idempotency: close
 * it with the original-safe temporary diagnostic and release capacity.
 * Any other state without a remote id is a genuinely empty completed result.
 */
export function syncNoRemotePollCode(
  operationState: string | null | undefined,
): 'PROVIDER_TEMPORARY_ERROR' | 'PROVIDER_EMPTY_RESULT' {
  return operationState === 'submitting' ? 'PROVIDER_TEMPORARY_ERROR' : 'PROVIDER_EMPTY_RESULT'
}
/**
 * Resolve the bounded output byte cap: unset falls back to the default cap,
 * but any explicitly configured NaN/Infinity/non-integer/non-positive or
 * over-cap value fails INVALID_CONFIG instead of allowing unbounded reads.
 */
export function resolveOutputMaxBytes(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return MAX_RESOLVED_OUTPUT_BYTES
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_RESOLVED_OUTPUT_BYTES) {
    throw new Error('INVALID_CONFIG')
  }
  return value
}

export function isLeaseExpired(expiresAt: string | Date | null | undefined, nowMs = Date.now()): boolean {
  if (!expiresAt) return true
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt)
  if (!Number.isFinite(ms)) return true
  return ms <= nowMs
}

export function canAcquireLease(
  currentToken: string | null | undefined,
  expiresAt: string | Date | null | undefined,
  requestToken: string,
  nowMs = Date.now(),
): boolean {
  if (!currentToken) return true
  if (currentToken === requestToken) return true
  return isLeaseExpired(expiresAt, nowMs)
}

export function isCancelRequested(job: { cancel_requested_at?: unknown; status?: unknown }): boolean {
  return Boolean((job as Record<string, unknown>).cancel_requested_at)
}

export function ingestionStorageKey(createdBy: string, runId: string, outputIndex: number, mimeType: string): string {
  const ext = mimeExtension(mimeType)
  const short = createHash('sha256').update(`${runId}:${outputIndex}`).digest('hex').slice(0, 12)
  return `${createdBy}/${runId}/${outputIndex}-${short}.${ext}`
}

function mimeExtension(mimeType: string): string {
  const lower = (mimeType || '').toLowerCase()
  if (lower === 'image/png') return 'png'
  if (lower === 'image/jpeg' || lower === 'image/jpg') return 'jpg'
  if (lower === 'image/webp') return 'webp'
  if (lower === 'video/mp4') return 'mp4'
  if (lower === 'video/webm') return 'webm'
  if (lower === 'video/quicktime') return 'mov'
  if (lower.startsWith('video/')) return 'mp4'
  if (lower.startsWith('image/')) return lower.split('/')[1].split('+')[0] || 'bin'
  return 'bin'
}

/** Redact secrets/URLs before logging. Never log provider payloads directly. */
export function redactForLog(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
      .slice(0, 500)
  }
  if (Array.isArray(value)) return value.map(redactForLog)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase()
      if (lower.includes('apikey') || lower.includes('api_key') || lower.includes('secret') || lower.includes('token') || lower.includes('credential') || lower.includes('payload') || lower === 'url' || lower.endsWith('url')) {
        out[key] = '[redacted]'
      } else {
        out[key] = redactForLog(entry)
      }
    }
    return out
  }
  return value
}

export const SYNC_RETRY_PERSISTENCE_ERROR_CODE = 'SYNC_RETRY_PERSISTENCE_FAILED'

/**
 * Marker for a failed synchronous-retry persistence transition (run CAS,
 * job status, or outbox insert). It must never be converted into a terminal
 * provider failure: processJob rethrows it, and the queue leaves the message
 * unacknowledged so XAUTOCLAIM redelivers it.
 */
export class SyncRetryPersistenceError extends Error {
  constructor(cause?: unknown) {
    super(SYNC_RETRY_PERSISTENCE_ERROR_CODE)
    this.name = 'SyncRetryPersistenceError'
    if (cause !== undefined) this.cause = cause
  }
}

export function isSyncRetryPersistenceError(error: unknown): boolean {
  return (
    error instanceof SyncRetryPersistenceError ||
    (error instanceof Error && error.message === SYNC_RETRY_PERSISTENCE_ERROR_CODE)
  )
}
