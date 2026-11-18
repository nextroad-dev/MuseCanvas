import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentCoreClient } from './agent-core'
import { settleLinkedAgentMediaReservations } from './agent-media-settlement'

const tool = { id: '60000000-0000-4000-8000-000000000001', turn_id: '30000000-0000-4000-8000-000000000001',
  session_id: '20000000-0000-4000-8000-000000000001' }

function fixture(jobs: { status: string; outputs: number; uncertain?: boolean }[],
  reservations: { id: string; quota: string; amount?: string; currency?: string | null; pricingRevision?: string | null }[]) {
  const calls: { sql: string; args: unknown[] }[] = []
  const state = { reservations: reservations.map(r => ({ ...r, reserved_amount: r.amount ?? '1',
    currency: r.currency === undefined ? 'USD' : r.currency,
    pricing_revision: r.pricingRevision === undefined ? 'price-v1' : r.pricingRevision, status: 'reserved' })) }
  const client = { async query(sql: string, args: unknown[] = []) {
    calls.push({ sql, args })
    if (sql.startsWith('SELECT l.media_job_id,j.status')) return { rows: jobs.map((job, i) => ({
      media_job_id: `job-${i}`, status: job.status, output_count: String(job.outputs),
      remote_uncertain: job.uncertain ?? false })) }
    if (sql.startsWith('SELECT * FROM agent_budget_reservations')) return { rows: structuredClone(state.reservations) }
    if (sql.startsWith("UPDATE agent_budget_reservations SET status='settled'")) {
      state.reservations.find(r => r.id === args[0])!.status = 'settled'; return { rows: [] } }
    if (sql.startsWith("UPDATE agent_budget_reservations SET status='released'")) {
      state.reservations.find(r => r.id === args[0])!.status = 'released'; return { rows: [] } }
    if (sql.startsWith("UPDATE agent_budget_reservations SET status='unknown'")) {
      state.reservations.find(r => r.id === args[0])!.status = 'unknown'; return { rows: [] } }
    if (sql.startsWith('INSERT INTO agent_usage_entries')) return { rows: [] }
    throw new Error(`unexpected SQL: ${sql}`)
  }, async transaction<T>(fn: (c: AgentCoreClient) => Promise<T>) { return fn(client) } } as unknown as AgentCoreClient
  return { calls, client, state }
}
type Fixture = ReturnType<typeof fixture>
const usages = (calls: { sql: string; args: unknown[] }[]) => calls.filter(c => c.sql.startsWith('INSERT INTO agent_usage_entries'))
/** Same-client accounting only: this module must never own a transaction. */
function assertNoTransactionControl(f: Fixture) {
  assert.ok(f.calls.every(call => !/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(call.sql)))
}

test('agent-media-settlement: no linked jobs leaves every reservation untouched for generic settlement', async () => {
  const f = fixture([], [{ id: 'r1', quota: 'model_calls' }])
  assert.equal(await settleLinkedAgentMediaReservations(f.client, tool), false)
  assert.equal(f.calls.length, 1)
})

test('agent-media-settlement: nonterminal local job aborts before touching reservations', async () => {
  const f = fixture([{ status: 'running', outputs: 0 }], [{ id: 'r1', quota: 'media_jobs' }])
  await assert.rejects(settleLinkedAgentMediaReservations(f.client, tool), { message: 'AGENT_MEDIA_NOT_TERMINAL' })
  assert.equal(f.state.reservations[0]!.status, 'reserved'); assert.equal(usages(f.calls).length, 0)
})

test('agent-media-settlement: actual media usage is derived from linked jobs and live owned outputs', async () => {
  const f = fixture([{ status: 'succeeded', outputs: 2 }, { status: 'canceled', outputs: 0 }],
    [{ id: 'r1', quota: 'media_jobs' }, { id: 'r2', quota: 'media_outputs' }, { id: 'r3', quota: 'model_calls' }])
  assert.equal(await settleLinkedAgentMediaReservations(f.client, tool), true)
  const [jobs, outputs] = usages(f.calls)
  assert.deepEqual([jobs!.args[3], jobs!.args[4]], ['media:jobs:60000000-0000-4000-8000-000000000001', '2'])
  assert.deepEqual([outputs!.args[3], outputs!.args[4]], ['media:outputs:60000000-0000-4000-8000-000000000001', '2'])
  assert.deepEqual(f.state.reservations.map(r => r.status), ['settled', 'settled', 'reserved'])
  assertNoTransactionControl(f)
})

test('agent-media-settlement: uncertain remote provider run keeps concurrency reserved and cost unknown', async () => {
  const f = fixture([{ status: 'succeeded', outputs: 1, uncertain: true }],
    [{ id: 'r1', quota: 'concurrent_media_jobs' }, { id: 'r2', quota: 'estimated_cost', amount: '0.4', currency: null }])
  assert.equal(await settleLinkedAgentMediaReservations(f.client, tool), true)
  assert.deepEqual(f.state.reservations.map(r => r.status), ['reserved', 'unknown'])
  const [usage] = usages(f.calls)
  assert.deepEqual([usage!.args[4], usage!.args[5]], ['0.4', null])
  assert.deepEqual(JSON.parse(String(usage!.args[6])), { quota: 'estimated_cost', unknownCost: true,
    reason: 'media_provider_cost_unknown', pricingRevision: 'price-v1' })
  assertNoTransactionControl(f)
})

test('agent-media-settlement: a frozen zero price settles as known actual cost', async () => {
  const f = fixture([{ status: 'succeeded', outputs: 1 }],
    [{ id: 'r1', quota: 'estimated_cost', amount: '0', currency: 'USD', pricingRevision: 'free-v1' }])
  assert.equal(await settleLinkedAgentMediaReservations(f.client, tool), true)
  assert.deepEqual(f.state.reservations.map(r => [r.id, r.status]), [['r1', 'settled']])
  const [usage] = usages(f.calls)
  assert.match(usage!.sql, /'actual'/)
  assert.deepEqual(usage!.args.slice(0, 6), [tool.session_id, tool.turn_id, 'r1', 'media:cost:r1', '0', 'USD'])
  assert.deepEqual(JSON.parse(String(usage!.args[6])), { quota: 'estimated_cost', reason: 'zero_price_revision',
    pricingRevision: 'free-v1' })
  assert.ok(!f.calls.some(c => c.sql.includes("SET status='unknown'")))
  assertNoTransactionControl(f)
})

test('agent-media-settlement: a nonzero frozen price stays unknown and never becomes zero', async () => {
  const f = fixture([{ status: 'succeeded', outputs: 1 }],
    [{ id: 'r1', quota: 'estimated_cost', amount: '0.25', currency: 'USD', pricingRevision: 'price-v1' }])
  assert.equal(await settleLinkedAgentMediaReservations(f.client, tool), true)
  assert.deepEqual(f.state.reservations.map(r => r.status), ['unknown'])
  const [usage] = usages(f.calls)
  assert.match(usage!.sql, /'unknown'/)
  assert.deepEqual([usage!.args[4], usage!.args[5]], ['0.25', 'USD'])
  assert.deepEqual(JSON.parse(String(usage!.args[6])), { quota: 'estimated_cost', unknownCost: true,
    reason: 'media_provider_cost_unknown', pricingRevision: 'price-v1' })
})

test('agent-media-settlement: a zero amount without a pricing revision stays unknown', async () => {
  const f = fixture([{ status: 'succeeded', outputs: 1 }],
    [{ id: 'r1', quota: 'estimated_cost', amount: '0', currency: 'USD', pricingRevision: null }])
  assert.equal(await settleLinkedAgentMediaReservations(f.client, tool), true)
  assert.deepEqual(f.state.reservations.map(r => r.status), ['unknown'])
  const [usage] = usages(f.calls)
  assert.match(usage!.sql, /'unknown'/)
  assert.deepEqual(JSON.parse(String(usage!.args[6])).unknownCost, true)
})

test('agent-media-settlement: a zero amount without a currency stays unknown', async () => {
  const f = fixture([{ status: 'succeeded', outputs: 1 }],
    [{ id: 'r1', quota: 'estimated_cost', amount: '0', currency: null, pricingRevision: 'free-v1' }])
  assert.equal(await settleLinkedAgentMediaReservations(f.client, tool), true)
  assert.deepEqual(f.state.reservations.map(r => r.status), ['unknown'])
  assert.equal(JSON.parse(String(usages(f.calls)[0]!.args[6])).unknownCost, true)
})

test('agent-media-settlement: zero-priced cost settles while the same call keeps its media counters', async () => {
  const f = fixture([{ status: 'succeeded', outputs: 2 }],
    [{ id: 'r1', quota: 'media_jobs' }, { id: 'r2', quota: 'media_outputs' },
      { id: 'r3', quota: 'concurrent_media_jobs' }, { id: 'r4', quota: 'estimated_cost', amount: '0', pricingRevision: 'free-v1' }])
  assert.equal(await settleLinkedAgentMediaReservations(f.client, tool), true)
  assert.deepEqual(f.state.reservations.map(r => [r.quota, r.status]), [
    ['media_jobs', 'settled'], ['media_outputs', 'settled'], ['concurrent_media_jobs', 'released'], ['estimated_cost', 'settled']])
  assert.deepEqual(usages(f.calls).map(usage => usage.args[3]), ['media:jobs:60000000-0000-4000-8000-000000000001',
    'media:outputs:60000000-0000-4000-8000-000000000001', 'media:cost:r4'])
})
