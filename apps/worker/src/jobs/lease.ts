import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { acquireWorkerLease, db, releaseWorkerLease, renewWorkerLease, updateProviderRunState as writeState, type ProviderRunEntity } from '@musecanvas/database'
import { PROVIDER_LEASE_SECONDS } from '../provider-state'
import type { ExecutionContext, SafeHttpRequestInit } from '@musecanvas/providers'

export class ProviderLeaseLostError extends Error {
  constructor() { super('PROVIDER_LEASE_LOST'); this.name = 'ProviderLeaseLostError' }
}
type Lease = { runId: string; token: string; lost: boolean; expiresAt: number; controller: AbortController }
const currentLease = new AsyncLocalStorage<Lease>()

export function assertProviderLease(): void {
  const lease = currentLease.getStore()
  if (!lease || lease.lost || Date.now() >= lease.expiresAt) {
    lease?.controller.abort(new ProviderLeaseLostError())
    throw new ProviderLeaseLostError()
  }
}

export function providerLeaseSignal(): AbortSignal {
  assertProviderLease()
  return currentLease.getStore()!.controller.signal
}

/** Prevent further plugin HTTP calls and abort active calls after ownership loss. */
export function fenceProviderContext(context: ExecutionContext): ExecutionContext {
  assertProviderLease()
  const lease = currentLease.getStore()!
  const request = async (url: string, init?: SafeHttpRequestInit) => {
    assertProviderLease()
    const signal = init?.signal ? AbortSignal.any([init.signal, lease.controller.signal]) : lease.controller.signal
    const response = await context.http.request(url, { ...init, signal })
    assertProviderLease()
    return response
  }
  return { ...context, http: {
    request,
    get: (url, init) => request(url, { ...init, method: 'GET' }),
    post: (url, body, init) => request(url, { ...init, body, method: 'POST' }),
  }, readOutput: async (descriptor, options) => {
    assertProviderLease()
    const result = await context.readOutput(descriptor, options)
    assertProviderLease()
    return result
  } }
}

/** All job-side state writes are fenced in the same SQL as their revision CAS. */
export async function updateProviderRunState(...[client, input]: Parameters<typeof writeState>) {
  assertProviderLease()
  const lease = currentLease.getStore()!
  if (lease.runId !== input.runId) throw new ProviderLeaseLostError()
  const updated = await writeState(client, { ...input, leaseToken: lease.token })
  if (!updated) throw new ProviderLeaseLostError()
  return updated
}

export async function withProviderLease<T>(runId: string, operation: (run: ProviderRunEntity) => Promise<T>): Promise<T | undefined> {
  const token = randomUUID()
  const acquiredAt = Date.now()
  const run = await acquireWorkerLease(db(), { runId, leaseToken: token, leaseDurationSeconds: PROVIDER_LEASE_SECONDS })
  if (!run) return undefined
  const lease: Lease = { runId, token, lost: false, expiresAt: acquiredAt + PROVIDER_LEASE_SECONDS * 1000, controller: new AbortController() }
  let renewing = false
  const timer = setInterval(() => {
    if (Date.now() >= lease.expiresAt) {
      lease.lost = true
      lease.controller.abort(new ProviderLeaseLostError())
    }
    if (renewing || lease.lost) return
    renewing = true
    // Use the request start as a conservative local deadline; DB latency must
    // never make a local lease appear newer than the actual database lease.
    const started = Date.now()
    void renewWorkerLease(db(), { runId, leaseToken: token, leaseDurationSeconds: PROVIDER_LEASE_SECONDS })
      .then(ok => { if (!ok) { lease.lost = true; lease.controller.abort(new ProviderLeaseLostError()) } else lease.expiresAt = started + PROVIDER_LEASE_SECONDS * 1000 })
      .catch(() => { lease.lost = true; lease.controller.abort(new ProviderLeaseLostError()) })
      .finally(() => { renewing = false })
  }, PROVIDER_LEASE_SECONDS * 1000 / 3)
  timer.unref()
  try { return await currentLease.run(lease, () => operation(run)) }
  finally {
    clearInterval(timer)
    await releaseWorkerLease(db(), runId, token).catch(() => {})
  }
}
