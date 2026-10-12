// Confirmation state machine for Agent generation proposals.
//
// A pending proposal is immutable: confirm/reject can only *advance the status* of
// the recorded row, and a conflict or expiry means the recorded inputs no longer
// describe what would be generated. The reducer below therefore never offers a
// silent retry — `requiresNewProposal` is set exactly when the user has to author a
// fresh request instead of re-submitting the stale pending.
//
// The server error codes are matched structurally (`error.code`) so this module has
// no runtime dependency on the API client.

import type { CanvasAgentConfirmResultDto, CanvasAgentPendingJobDto } from '@musecanvas/contracts'

export type ConfirmationAction = 'confirm' | 'reject'
export type ConfirmationPhase =
  | 'idle'
  | 'submitting'
  | 'submitted'
  | 'rejected'
  | 'expired'
  | 'conflict'
  | 'error'

export interface PendingConfirmation {
  pendingId: string
  action: ConfirmationAction | null
  phase: ConfirmationPhase
  message: string | null
  /** The stale pending must not be re-submitted or PATCHed; a new request is needed. */
  requiresNewProposal: boolean
}

export type ConfirmationMap = Record<string, PendingConfirmation>

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : null
}

function errorMessageOf(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return null
}

export interface ConfirmErrorInfo {
  phase: ConfirmationPhase
  message: string
  requiresNewProposal: boolean
}

/**
 * Classify a failed confirm/reject. A 409 conflict or expiry (and a 404 that means
 * the row is gone) all invalidate the proposal: the card must offer a *new* request,
 * never a retry of the recorded pending.
 */
export function classifyConfirmError(error: unknown): ConfirmErrorInfo {
  const code = errorCodeOf(error)
  if (code === 'CANVAS_AGENT_CONFIRM_CONFLICT') {
    return { phase: 'conflict', message: '提案的输入或画布版本已变化，无法再确认。请发送新的请求生成新提案。', requiresNewProposal: true }
  }
  if (code === 'CANVAS_AGENT_CONFIRM_EXPIRED') {
    return { phase: 'expired', message: '提案已过期，无法再确认。请发送新的请求生成新提案。', requiresNewProposal: true }
  }
  if (code === 'CANVAS_AGENT_CONFIRM_NOT_FOUND') {
    return { phase: 'expired', message: '提案不存在或已被处理，请刷新历史后发送新的请求。', requiresNewProposal: true }
  }
  return { phase: 'error', message: errorMessageOf(error) ?? '确认失败，请稍后重试。', requiresNewProposal: false }
}

export function createConfirmationState(): ConfirmationMap {
  return {}
}

/** Claim the per-pending lock synchronously when the user activates confirm/reject. */
export function beginConfirmation(
  map: ConfirmationMap,
  pendingId: string,
  action: ConfirmationAction,
): ConfirmationMap {
  return {
    ...map,
    [pendingId]: { pendingId, action, phase: 'submitting', message: null, requiresNewProposal: false },
  }
}

function phaseFromStatus(status: CanvasAgentPendingJobDto['status']): ConfirmationPhase {
  switch (status) {
    case 'submitting': return 'submitting'
    case 'submitted': return 'submitted'
    case 'rejected': return 'rejected'
    case 'expired': return 'expired'
    default: return 'idle'
  }
}

/** Reconcile the card with the pending snapshot the confirm response returned. */
export function confirmationSucceeded(
  map: ConfirmationMap,
  result: CanvasAgentConfirmResultDto,
): ConfirmationMap {
  const previous = map[result.pending.id]
  return {
    ...map,
    [result.pending.id]: {
      pendingId: result.pending.id,
      action: previous?.action ?? null,
      phase: phaseFromStatus(result.pending.status),
      message: null,
      requiresNewProposal: false,
    },
  }
}

export function confirmationFailed(
  map: ConfirmationMap,
  pendingId: string,
  error: unknown,
): ConfirmationMap {
  const previous = map[pendingId]
  const info = classifyConfirmError(error)
  return {
    ...map,
    [pendingId]: {
      pendingId,
      action: previous?.action ?? null,
      phase: info.phase,
      message: info.message,
      requiresNewProposal: info.requiresNewProposal,
    },
  }
}

export function confirmationFor(map: ConfirmationMap, pendingId: string): PendingConfirmation {
  return map[pendingId] ?? { pendingId, action: null, phase: 'idle', message: null, requiresNewProposal: false }
}

/** True while a confirm/reject for this pending is in flight (button stays locked). */
export function isConfirmationBusy(map: ConfirmationMap, pendingId: string): boolean {
  return confirmationFor(map, pendingId).phase === 'submitting'
}
