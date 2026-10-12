import { CanvasErrorCode as C, isCanvasUuid, type CanvasAgentConfirmRequest } from '@musecanvas/contracts'
import { canvasAgentGenerationRequest } from '../../../../../../packages/database/src/index'
import type { Actor } from '../../../auth/security'
import type { createGenerationJob } from '../../generations/create-job'
import type { AgentStore } from './store'
import { raise } from './config'
export type GenerationCreate = typeof createGenerationJob
/** Claim commits before generation's separate transaction. A crash leaves `submitting` for
 * lease-expiry recovery with the SAME persisted key/payload; this is not cross-service atomicity. */
export async function submitPending(store: AgentStore, actor: Actor, canvasId: string, request: CanvasAgentConfirmRequest, create: GenerationCreate, signal: AbortSignal, timeoutMs: number) {
  if (signal.aborted) raise(C.CANVAS_AGENT_CANCELED, 409)
  const claim = await store.claim(actor.id, canvasId, request, timeoutMs)
  if (!claim.claimed) return claim.pending
  const pending = claim.pending
  if (signal.aborted) raise(C.CANVAS_AGENT_CANCELED, 409)
  const generationRequest = canvasAgentGenerationRequest(pending)
  const response = await create({ actor, modelId: generationRequest.modelId, prompt: generationRequest.prompt, parameters: generationRequest.parameters,
    normalizedInputs: generationRequest.inputs, idempotencyKey: pending.idempotencyKey,
    ...(pending.requestVersion === 2 ? { intendedMode: generationRequest.mode } : {}) })
  let envelope: unknown
  try { envelope = await response.json() } catch { return raise(C.CANVAS_AGENT_FAILED, 503) }
  const body = envelope as { success?: boolean; data?: { id?: unknown } }
  if (!response.ok || !body?.success || !isCanvasUuid(body.data?.id)) raise(C.CANVAS_AGENT_FAILED, 503)
  // Do not revoke a committed job on disconnect. Completion is persisted for replay/recovery.
  return store.complete(claim.scope, pending, body.data.id)
}
