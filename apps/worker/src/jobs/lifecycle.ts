import type { ProviderRunEntity } from '@musecanvas/database'
import type { OperationResult } from '@musecanvas/providers'

export const MAX_PRE_RUN_ATTEMPTS = 3

/** Do not reinterpret failed lifecycle persistence as a provider rejection. */
export class LifecyclePersistenceError extends Error {
  constructor(cause: unknown) {
    super('LIFECYCLE_PERSISTENCE_FAILED', { cause })
    this.name = 'LifecyclePersistenceError'
  }
}

/** Never extend uncertainty using updatedAt: every poll updates that timestamp. */
export function unknownSubmissionExpired(run: Pick<ProviderRunEntity, 'submittedAt' | 'createdAt'>, budgetMs: number, now = Date.now()): boolean {
  const started = Date.parse(run.submittedAt || run.createdAt)
  return !Number.isFinite(started) || now >= started + budgetMs
}

/** Unknown submissions have no safe resubmit path, even after the deadline. */
export async function reconcileUnknownSubmission(run: Pick<ProviderRunEntity, 'submittedAt' | 'createdAt'>, budgetMs: number, actions: {
  expire(): Promise<void>
  wait(): Promise<void>
}): Promise<void> {
  if (unknownSubmissionExpired(run, budgetMs)) await actions.expire()
  else await actions.wait()
}

/** Only the provider call is recoverable here; fencing and persistence errors escape. */
export async function reconcileCancellation(callbacks: {
  invoke(): Promise<OperationResult | undefined>
  assertLease(): void
  isLeaseLost(error: unknown): boolean
  pending(result?: OperationResult): Promise<void>
  terminal(result: OperationResult): Promise<void>
}): Promise<void> {
  let result: OperationResult | undefined
  try {
    callbacks.assertLease()
    result = await callbacks.invoke()
  } catch (error) {
    if (callbacks.isLeaseLost(error)) throw error
    callbacks.assertLease()
    await callbacks.pending()
    return
  }
  callbacks.assertLease()
  if (result && ['canceled', 'succeeded', 'failed'].includes(result.status)) {
    await callbacks.terminal(result)
  } else {
    await callbacks.pending(result)
  }
}
