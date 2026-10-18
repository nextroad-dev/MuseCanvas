import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@musecanvas/database'
import { assertProviderLease, fenceProviderContext, ProviderLeaseLostError, updateProviderRunState, withProviderLease } from './lease'
import type { ExecutionContext } from '@musecanvas/providers'

function runRow(id: string, token: string) {
  return { id, job_id: 'job', attempt: 1, provider_id: 'provider', plugin_id: 'plugin', plugin_version: '1',
    operation_state: 'waiting', client_token: id, state_revision: 1, worker_lease_token: token,
    worker_lease_expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() }
}

test('parallel lease scopes fence each state write with its own token and reject CAS failures', async t => {
  const tokens = new Map<string, string>()
  const writes: string[] = []
  t.mock.method(db(), 'query', async (sql: string, values: unknown[]) => {
    if (sql.includes('worker_lease_token = $2')) {
      tokens.set(String(values[0]), String(values[1]))
      return { rows: [runRow(String(values[0]), String(values[1]))] }
    }
    if (sql.includes('state_revision = state_revision + 1')) {
      assert.match(sql, /worker_lease_token = \$\d+ AND worker_lease_expires_at > now\(\)/)
      assert.equal(values.at(-1), tokens.get(String(values[0])))
      writes.push(String(values[0]))
      return { rows: values[0] === 'stolen' ? [] : [runRow(String(values[0]), String(values.at(-1)))] }
    }
    return { rows: [{ id: values[0] }] }
  })
  await Promise.all(['a', 'b'].map(id => withProviderLease(id, async () => {
    await new Promise(resolve => setTimeout(resolve, id === 'a' ? 5 : 1))
    await updateProviderRunState(db(), { runId: id, expectedStateRevision: 1, operationState: 'waiting' })
  })))
  assert.deepEqual(writes.sort(), ['a', 'b'])
  assert.notEqual(tokens.get('a'), tokens.get('b'))
  await assert.rejects(withProviderLease('stolen', async () => {
    await updateProviderRunState(db(), { runId: 'stolen', expectedStateRevision: 1 })
  }), ProviderLeaseLostError)
  assert.throws(assertProviderLease, ProviderLeaseLostError)
})

test('renewal runs without overlap and lease loss prevents later external effects', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let renews = 0
  let resolveRenew: (result: { rows: unknown[] }) => void = () => {}
  t.mock.method(db(), 'query', async (sql: string, values: unknown[]) => {
    if (sql.includes('worker_lease_token = $2')) return { rows: [runRow(String(values[0]), String(values[1]))] }
    if (sql.includes('worker_lease_expires_at=now()+')) {
      assert.match(sql, /worker_lease_expires_at>now\(\)/)
      renews++
      return new Promise(resolve => { resolveRenew = resolve })
    }
    return { rows: [] }
  })
  await withProviderLease('a', async () => {
    t.mock.timers.tick(20_000)
    t.mock.timers.tick(20_000)
    assert.equal(renews, 1)
    resolveRenew({ rows: [] })
    await new Promise(resolve => setImmediate(resolve))
    assert.throws(assertProviderLease, ProviderLeaseLostError)
    await assert.rejects(updateProviderRunState(db(), { runId: 'a', expectedStateRevision: 1 }), ProviderLeaseLostError)
  })
})

test('an elapsed lease fails closed even while its renewal is blocked', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  t.mock.method(db(), 'query', async (sql: string, values: unknown[]) => {
    if (sql.includes('worker_lease_token = $2')) return { rows: [runRow(String(values[0]), String(values[1]))] }
    if (sql.includes('worker_lease_expires_at=now()+')) return new Promise(() => {})
    return { rows: [] }
  })
  await withProviderLease('a', async () => {
    t.mock.timers.tick(60_001)
    assert.throws(assertProviderLease, ProviderLeaseLostError)
  })
})

test('lease loss aborts active plugin HTTP and blocks later HTTP calls', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  t.mock.method(db(), 'query', async (sql: string, values: unknown[]) => {
    if (sql.includes('worker_lease_token = $2')) return { rows: [runRow(String(values[0]), String(values[1]))] }
    return { rows: [] }
  })
  await withProviderLease('a', async () => {
    let requests = 0
    const context = fenceProviderContext({
      pluginId: 'test', version: '1',
      http: { request: async (_url: string, init?: { signal?: AbortSignal }) => {
        requests++
        return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
      } },
    } as unknown as ExecutionContext)
    const request = context.http.get('https://provider.example/job')
    const rejected = assert.rejects(request, ProviderLeaseLostError)
    t.mock.timers.tick(20_000)
    await rejected
    await assert.rejects(context.http.post('https://provider.example/new'), ProviderLeaseLostError)
    assert.equal(requests, 1)
  })
})
