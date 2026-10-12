// Continuation gating for a finished media job.
//
// "Continue planning" is a *new language-model turn* triggered by a job reaching a
// terminal success. It is deliberately opt-in: the default is off, and even when it
// is on the same job never continues twice. A user click is the other explicit
// authorisation. There is no timer, no watcher on mount, and no hidden auto-resubmit
// — the gate below is the single place that decides.

import type { CanvasAgentMessageRequest } from '@musecanvas/contracts'
import type { JobStatus } from '@/shared/types'

export interface ContinuationGateInput {
  /** The explicit "结果完成后继续规划（再次调用语言模型）" opt-in. Defaults off. */
  optIn: boolean
  /** The user pressed 继续规划 on this job. */
  explicitClick: boolean
  jobStatus: JobStatus | null
  /** This job already produced one continuation; never fold it in again. */
  alreadyContinued: boolean
  streaming: boolean
  agentCanGenerate: boolean
}

/**
 * Whether a `job_event` continuation may be sent.
 *
 * A click re-plans even if the job was continued before (the user asked again). The
 * opt-in path only fires once per job and only after a successful result.
 */
export function shouldContinuePlanning(input: ContinuationGateInput): boolean {
  if (input.streaming || !input.agentCanGenerate) return false
  if (input.jobStatus !== 'succeeded') return false
  if (input.explicitClick) return true
  return input.optIn && !input.alreadyContinued
}

/** The `job_event` request the continuation sends. Agent-managed like every other
 *  turn from this client; the server resolves the job state itself. */
export function buildContinuationRequest(input: {
  messageId: string
  jobId: string
  baseRevision: number
}): CanvasAgentMessageRequest {
  return {
    kind: 'job_event',
    messageId: input.messageId,
    jobId: input.jobId,
    baseRevision: input.baseRevision,
    sceneCommitMode: 'agent-managed',
  }
}
