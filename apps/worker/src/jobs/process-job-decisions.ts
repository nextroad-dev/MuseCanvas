import type { OperationResult } from '../../../../packages/providers/src/index'
import { isCancelRequested } from '../provider-state'

type ClaimDecision = 'ignore' | 'cancel' | 'claim'

/** Pure claim gate; SQL lock/update order remains owned by processJob. */
export function decideJobClaim(job: Record<string, unknown> | undefined): ClaimDecision {
  if (!job || !['queued', 'retry_wait'].includes(String(job.status))) return 'ignore'
  return isCancelRequested(job) ? 'cancel' : 'claim'
}

export function decideClaimedJob(current: Record<string, unknown> | undefined): 'cancel' | 'continue' {
  return !current || current.status === 'canceled' || isCancelRequested(current) ? 'cancel' : 'continue'
}

export function decideCapacityDenial(reason: string | undefined): 'terminal_invalid_config' | 'requeue' {
  return (reason || 'CONCURRENCY_LIMIT_EXCEEDED') === 'MODEL_NOT_FOUND' ? 'terminal_invalid_config' : 'requeue'
}

export type SubmitResultDisposition = 'waiting' | 'submission_unknown' | 'submitting' | 'terminal' | 'empty_sync_remote'

export function decideSubmitResult(result: OperationResult, synchronous: boolean): SubmitResultDisposition {
  if (result.status === 'waiting' || result.status === 'submission_unknown') {
    return !result.remoteId && synchronous ? 'empty_sync_remote' : result.status
  }
  if (result.status === 'submitting') return 'submitting'
  return 'terminal'
}
