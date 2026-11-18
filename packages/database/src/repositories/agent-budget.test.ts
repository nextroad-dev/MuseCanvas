import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentBudgetReserveInput, AgentBudgetSettleInput } from './agent-budget'
import { AgentBudgetRepository } from './agent-budget'
import type { AgentCoreClient, AgentCoreTransaction } from './agent-core'

const scope = { ownerId: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000001', turnId: '30000000-0000-4000-8000-000000000001' }
const toolCallId = '60000000-0000-4000-8000-000000000001'
const roundId = '70000000-0000-4000-8000-000000000001'
const now = Date.parse('2099-11-17T08:00:00Z')
const otherId = '00000000-0000-4000-8000-000000000099'
const NANO = 1_000_000_000n

function amountUnits(value: string): bigint {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole!) * NANO + BigInt(fraction.padEnd(9, '0'))
}
function amountFromUnits(value: bigint): string {
  const whole = value / NANO, fraction = (value % NANO).toString().padStart(9, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}
function addAmount(left: string, right: string): string { return amountFromUnits(amountUnits(left) + amountUnits(right)) }
function first(values: Set<string | null>): string | null {
  const list = [...values].filter((value): value is string => value !== null).sort()
  return list[0] ?? null
}
function last(values: Set<string | null>): string | null {
  const list = [...values].filter((value): value is string => value !== null).sort()
  return list.at(-1) ?? null
}

function budget() {
  return {
    maxModelCalls: 2, maxToolCalls: 2, maxMediaJobs: 1, maxMediaOutputs: 1,
    maxInputTokens: '10', maxOutputTokens: '10',
    maxEstimatedCost: { amount: '1', currency: 'USD', pricingReference: 'pricing-1' },
    maxConcurrentMediaJobs: 1,
  }
}
function initial() {
  return {
    session: { id: scope.sessionId, owner_id: scope.ownerId },
    turn: { id: scope.turnId, session_id: scope.sessionId, engine_version: 'agent-core-v1', status: 'running',
      cancel_requested_at: null as Date | null, deadline_at: new Date(now + 60000) as Date | null,
      budget_snapshot: budget() as any },
    reservations: [] as any[],
    usage: [] as any[],
    nextReservation: 1,
    nextUsage: 1,
  }
}

// Deliberately limited in-memory SQL model: it verifies owner/state predicates,
// idempotency keys, aggregates and transaction rollback propagation. It is not
// PostgreSQL isolation, constraint, trigger or numeric-precision validation.
function fixture() {
  let state = initial(), dbTime = now
  const calls: { sql: string; args: unknown[] }[] = []
  const readOnly: boolean[] = []
  let commits = 0, rollbacks = 0
  const copy = <T>(value: T): T => structuredClone(value)
  const id = (prefix: string, value: number) => `${prefix}-0000-4000-8000-${String(value).padStart(12, '0')}`
  const turnMatches = (args: unknown[]) => state.session.owner_id === args[0] && state.session.id === args[1] && state.turn.id === args[2]
  const executable = () => ['completed', 'failed', 'cancelled'].indexOf(state.turn.status) < 0
    && state.turn.cancel_requested_at === null && state.turn.deadline_at !== null && state.turn.deadline_at.getTime() > dbTime
  const reservation = (args: unknown[]) => state.reservations.find(row =>
    row.session_id === args[1] && row.turn_id === args[2] && row.id === args[3]
    && state.session.owner_id === args[0])
  const aggregateReservations = (sessionId: string, turnId: string) => {
    const groups = new Map<string, { amount: string; currency: Set<string | null>; pricing: Set<string | null> }>()
    for (const row of state.reservations) {
      if (row.session_id !== sessionId || row.turn_id !== turnId || row.status !== 'reserved') continue
      const group = groups.get(row.quota) ?? { amount: '0', currency: new Set(), pricing: new Set() }
      group.amount = addAmount(group.amount, row.reserved_amount)
      group.currency.add(row.currency); group.pricing.add(row.pricing_revision)
      groups.set(row.quota, group)
    }
    return [...groups].map(([quota, group]) => ({ quota, amount: group.amount,
      currency: first(group.currency), currency_max: last(group.currency),
      pricing_revision: first(group.pricing), pricing_revision_max: last(group.pricing) }))
  }
  const aggregateUsage = (sessionId: string, turnId: string) => {
    const groups = new Map<string | null, { amount: string; currency: Set<string | null>; pricing: Set<string | null> }>()
    for (const row of state.usage) {
      if (row.session_id !== sessionId || row.turn_id !== turnId) continue
      const half = state.reservations.find(r => r.id === row.reservation_id && r.turn_id === row.turn_id && r.session_id === row.session_id)
      const group = groups.get(row.details.quota) ?? { amount: '0', currency: new Set(), pricing: new Set() }
      group.amount = addAmount(group.amount, row.amount)
      group.currency.add(row.currency ?? half?.currency ?? null)
      group.pricing.add(half?.pricing_revision ?? null)
      groups.set(row.details.quota, group)
    }
    return [...groups].map(([quota, group]) => ({ quota, amount: group.amount,
      currency: first(group.currency), currency_max: last(group.currency),
      pricing_revision: first(group.pricing), pricing_revision_max: last(group.pricing),
      unknown_cost: state.usage.some(row => row.session_id === sessionId && row.turn_id === turnId
        && (row.details.quota ?? null) === quota && (row.usage_kind === 'unknown' || row.details.unknownCost === true)) }))
  }
  const client = { async query(raw: string, args: unknown[] = []) {
    const sql = raw.replace(/\s+/g, ' ').trim()
    calls.push({ sql, args })
    const binds = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]))
    assert.equal(binds.length ? Math.max(...binds) : 0, args.length)
    if (sql.startsWith('SELECT t.* FROM agent_turns t JOIN agent_sessions s')) {
      if (!turnMatches(args)) return { rows: [] }
      if (sql.includes('FOR UPDATE OF t') && !executable()) return { rows: [] }
      return { rows: [copy(state.turn)] }
    }
    if (sql.startsWith('SELECT * FROM agent_budget_reservations WHERE turn_id=')) {
      const row = state.reservations.find(value => value.turn_id === args[0] && value.idempotency_key === args[1])
      return { rows: row ? [copy(row)] : [] }
    }
    if (sql.includes('SUM(reserved_amount)')) {
      return { rows: aggregateReservations(String(args[0]), String(args[1])) }
    }
    if (sql.includes('FROM agent_usage_entries u')) {
      return { rows: aggregateUsage(String(args[0]), String(args[1])) }
    }
    if (sql.startsWith('INSERT INTO agent_budget_reservations')) {
      if (state.reservations.some(row => row.turn_id === args[1] && row.idempotency_key === args[8])) throw new Error('duplicate reservation')
      const row = { id: id('40000000', state.nextReservation++), session_id: args[0], turn_id: args[1],
        tool_call_id: args[2], round_id: args[3], quota: args[4], reserved_amount: args[5], currency: args[6],
        pricing_revision: args[7], status: 'reserved', idempotency_key: args[8], created_at: new Date(dbTime), settled_at: null }
      state.reservations.push(row)
      return { rows: [copy(row)] }
    }
    if (sql.startsWith('SELECT r.* FROM agent_budget_reservations r')) {
      const row = reservation(args)
      return { rows: row ? [copy(row)] : [] }
    }
    if (sql.startsWith('INSERT INTO agent_usage_entries')) {
      if (state.usage.some(row => row.turn_id === args[1] && row.settlement_key === args[3])) return { rows: [] }
      const row = { id: id('50000000', state.nextUsage++), session_id: args[0], turn_id: args[1], reservation_id: args[2],
        settlement_key: args[3], usage_kind: args[4], amount: args[5], currency: args[6],
        details: JSON.parse(String(args[7])), created_at: new Date(dbTime) }
      state.usage.push(row)
      return { rows: [{ id: row.id }] }
    }
    if (sql.startsWith('SELECT * FROM agent_usage_entries WHERE turn_id=')) {
      const row = state.usage.find(value => value.turn_id === args[0] && value.settlement_key === args[1])
      return { rows: row ? [copy(row)] : [] }
    }
    if (sql.startsWith("UPDATE agent_budget_reservations SET status='settled'")) {
      const row = state.reservations.find(value => value.id === args[0] && value.session_id === args[1]
        && value.turn_id === args[2] && value.status === 'reserved')
      if (!row) return { rows: [] }
      row.status = 'settled'; row.settled_at = new Date(dbTime)
      return { rows: [copy(row)] }
    }
    if (sql.startsWith("UPDATE agent_budget_reservations SET status='released'")) {
      const row = state.reservations.find(value => value.id === args[0] && value.session_id === args[1]
        && value.turn_id === args[2] && value.status === 'reserved')
      if (!row) return { rows: [] }
      row.status = 'released'; row.settled_at = new Date(dbTime)
      return { rows: [copy(row)] }
    }
    throw new Error(`unexpected fixture SQL: ${sql}`)
  } } as unknown as AgentCoreClient
  const tx: AgentCoreTransaction = async (work, readOnlyWork = false) => {
    readOnly.push(readOnlyWork)
    const before = copy(state)
    try { const value = await work(client); commits++; return value }
    catch (error) { state = before; rollbacks++; throw error }
  }
  return { repo: new AgentBudgetRepository(tx), calls, readOnly,
    get state() { return state }, get commits() { return commits }, get rollbacks() { return rollbacks },
    setTime(value: number) { dbTime = value } }
}

function reserve(overrides: Partial<AgentBudgetReserveInput> = {}): AgentBudgetReserveInput {
  return { ...scope, quota: 'model_calls', amount: '1', idempotencyKey: 'reserve-1', ...overrides }
}
function settle(reservationId: string, overrides: Partial<AgentBudgetSettleInput> = {}): AgentBudgetSettleInput {
  return { ...scope, reservationId, actualAmount: '1', usageKind: 'actual', settlementKey: 'settle-1', ...overrides }
}

test('agent-budget: malformed input is rejected before a transaction is opened', () => {
  const f = fixture()
  const invalid: [string, () => unknown][] = [
    ['owner', () => f.repo.reserve(reserve({ ownerId: '' }))],
    ['session', () => f.repo.reserve(reserve({ sessionId: 'not-a-uuid' }))],
    ['turn', () => f.repo.reserve(reserve({ turnId: '' }))],
    ['quota', () => f.repo.reserve(reserve({ quota: 'credits' as never }))],
    ['leading zero amount', () => f.repo.reserve(reserve({ amount: '01' }))],
    ['negative amount', () => f.repo.reserve(reserve({ amount: '-1' }))],
    ['too many decimals', () => f.repo.reserve(reserve({ amount: '1.0000000001' }))],
    ['exponent amount', () => f.repo.reserve(reserve({ amount: '1e3' }))],
    ['fractional counter', () => f.repo.reserve(reserve({ amount: '1.5' }))],
    ['empty key', () => f.repo.reserve(reserve({ idempotencyKey: '' }))],
    ['long key', () => f.repo.reserve(reserve({ idempotencyKey: 'x'.repeat(513) }))],
    ['NUL key', () => f.repo.reserve(reserve({ idempotencyKey: 'a\0b' }))],
    ['tool call id', () => f.repo.reserve(reserve({ toolCallId: 'tool' }))],
    ['round id', () => f.repo.reserve(reserve({ roundId: '' }))],
    ['currency on counter', () => f.repo.reserve(reserve({ currency: 'USD' }))],
    ['cost without currency', () => f.repo.reserve(reserve({ quota: 'estimated_cost', amount: '0.1', pricingRevision: 'pricing-1' }))],
    ['cost without pricing', () => f.repo.reserve(reserve({ quota: 'estimated_cost', amount: '0.1', currency: 'USD' }))],
    ['lowercase currency', () => f.repo.reserve(reserve({ quota: 'estimated_cost', amount: '0.1', currency: 'usd', pricingRevision: 'pricing-1' }))],
    ['long currency', () => f.repo.reserve(reserve({ quota: 'estimated_cost', amount: '0.1', currency: 'USDX', pricingRevision: 'pricing-1' }))],
    ['empty pricing', () => f.repo.reserve(reserve({ quota: 'estimated_cost', amount: '0.1', currency: 'USD', pricingRevision: '' }))],
    ['settle reservation', () => f.repo.settle(settle('', { ownerId: otherId }))],
    ['settle amount', () => f.repo.settle(settle('x'))],
    ['settle kind', () => f.repo.settle(settle('x', { usageKind: 'bogus' as never }))],
    ['settle key', () => f.repo.settle(settle('x', { settlementKey: '' }))],
    ['settle details', () => f.repo.settle(settle('x', { details: [] as never }))],
    ['release reservation', () => f.repo.release({ ...scope, reservationId: 'x' })],
    ['usage scope', () => f.repo.usage({ ...scope, ownerId: '' })],
  ]
  for (const [name, run] of invalid) assert.throws(run, { code: 'INVALID_INPUT' }, name)
  assert.equal(f.calls.length, 0)
  assert.equal(f.commits, 0)
})

test('agent-budget: reserve locks an owner-scoped live turn and persists an explicit reservation DTO', async () => {
  const f = fixture()
  const result = await f.repo.reserve(reserve({ amount: '2', toolCallId, roundId }))
  assert.deepEqual(result, { id: '40000000-0000-4000-8000-000000000001', quota: 'model_calls', amount: '2',
    status: 'reserved', currency: null, pricingRevision: null, createdAt: new Date(now).toISOString() })
  const lock = f.calls[0]!
  assert.match(lock.sql, /JOIN agent_sessions s ON s\.id=t\.session_id/)
  assert.match(lock.sql, /s\.owner_id=\$1 AND s\.id=\$2 AND t\.id=\$3/)
  assert.match(lock.sql, /engine_version='agent-core-v1'/)
  assert.match(lock.sql, /status NOT IN \('completed','failed','cancelled'\)/)
  assert.match(lock.sql, /cancel_requested_at IS NULL/)
  assert.match(lock.sql, /deadline_at > clock_timestamp\(\) FOR UPDATE OF t/)
  assert.deepEqual(lock.args, [scope.ownerId, scope.sessionId, scope.turnId])
  const insert = f.calls.find(c => c.sql.startsWith('INSERT INTO agent_budget_reservations'))!
  assert.match(insert.sql, /status,idempotency_key\) VALUES\(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,'reserved',\$9\)/)
  assert.deepEqual(insert.args, [scope.sessionId, scope.turnId, toolCallId, roundId, 'model_calls', '2', null, null, 'reserve-1'])
  assert.equal(f.state.reservations.length, 1)
  assert.equal(f.state.reservations[0]!.status, 'reserved')
  assert.equal(f.commits, 1)
})

test('agent-budget: estimated cost reservations require currency/pricing and preserve fractional amounts', async () => {
  const f = fixture()
  const result = await f.repo.reserve(reserve({ quota: 'estimated_cost', amount: '0.25', currency: 'USD',
    pricingRevision: 'pricing-1', idempotencyKey: 'cost-1' }))
  assert.equal(result.quota, 'estimated_cost')
  assert.equal(result.amount, '0.25')
  assert.equal(result.currency, 'USD')
  assert.equal(result.pricingRevision, 'pricing-1')
})

test('agent-budget: identical reserve replay returns the same reservation, while changed fields conflict', async () => {
  const f = fixture()
  const first = await f.repo.reserve(reserve({ amount: '1.0', idempotencyKey: 'same' }))
  const replay = await f.repo.reserve(reserve({ amount: '1', idempotencyKey: 'same' }))
  assert.deepEqual(replay, first)
  await assert.rejects(f.repo.reserve(reserve({ amount: '2', idempotencyKey: 'same' })), { code: 'CONFLICT' })
  await assert.rejects(f.repo.reserve(reserve({ quota: 'tool_calls', amount: '1', idempotencyKey: 'same' })), { code: 'CONFLICT' })
  assert.equal(f.state.reservations.length, 1)

  const cost = await f.repo.reserve(reserve({ quota: 'estimated_cost', amount: '0.1', currency: 'USD',
    pricingRevision: 'pricing-1', idempotencyKey: 'cost' }))
  assert.deepEqual(await f.repo.reserve(reserve({ quota: 'estimated_cost', amount: '0.1', currency: 'USD',
    pricingRevision: 'pricing-1', idempotencyKey: 'cost' })), cost)
  await assert.rejects(f.repo.reserve(reserve({ quota: 'estimated_cost', amount: '0.1', currency: 'USD',
    pricingRevision: 'pricing-2', idempotencyKey: 'cost' })), { code: 'CONFLICT' })
})

test('agent-budget: canReserveAgentBudget enforces counter, token and deadline ceilings', async () => {
  const f = fixture()
  await f.repo.reserve(reserve({ amount: '2' }))
  await assert.rejects(f.repo.reserve(reserve({ amount: '1', idempotencyKey: 'r2' })), { code: 'BUDGET_EXCEEDED' })
  assert.equal(f.state.reservations.length, 1)

  const tokens = fixture()
  await tokens.repo.reserve(reserve({ quota: 'input_tokens', amount: '10', idempotencyKey: 't1' }))
  await assert.rejects(tokens.repo.reserve(reserve({ quota: 'input_tokens', amount: '1', idempotencyKey: 't2' })),
    { code: 'BUDGET_EXCEEDED' })
  assert.equal(tokens.state.reservations.length, 1)

  const deadline = fixture()
  const originalNow = Date.now
  Date.now = () => now + 60000
  try {
    await assert.rejects(deadline.repo.reserve(reserve()), { code: 'BUDGET_EXCEEDED' })
  } finally { Date.now = originalNow }
  assert.equal(deadline.state.reservations.length, 0)
})

test('agent-budget: settle is idempotent by key and amount and injects quota attribution', async () => {
  const f = fixture()
  const reservation = await f.repo.reserve(reserve({ amount: '2' }))
  const input = settle(reservation.id, { actualAmount: '1', details: { provider: 'p1' } })
  const settled = await f.repo.settle(input)
  assert.equal(settled.status, 'settled')
  assert.equal(settled.amount, '2')
  assert.equal(f.state.reservations[0]!.status, 'settled')
  assert.ok(f.state.reservations[0]!.settled_at instanceof Date)
  assert.equal(f.state.usage.length, 1)
  assert.deepEqual(f.state.usage[0]!.details, { provider: 'p1', quota: 'model_calls' })
  assert.equal(f.state.usage[0]!.reservation_id, reservation.id)
  assert.equal(f.state.usage[0]!.currency, null)
  assert.deepEqual(await f.repo.settle(input), settled)
  assert.equal(f.state.usage.length, 1)
  await assert.rejects(f.repo.settle({ ...input, actualAmount: '2' }), { code: 'CONFLICT' })
  await assert.rejects(f.repo.settle({ ...input, settlementKey: 'other' }), { code: 'CONFLICT' })
  assert.equal(f.state.usage.length, 1)
})

test('agent-budget: a settlement key already used by another reservation conflicts without settling it', async () => {
  const f = fixture()
  const first = await f.repo.reserve(reserve({ idempotencyKey: 'a' }))
  const second = await f.repo.reserve(reserve({ idempotencyKey: 'b' }))
  await f.repo.settle(settle(first.id, { settlementKey: 'shared' }))
  await assert.rejects(f.repo.settle(settle(second.id, { settlementKey: 'shared' })), { code: 'CONFLICT' })
  assert.equal(f.state.reservations[0]!.status, 'settled')
  assert.equal(f.state.reservations[1]!.status, 'reserved')
  assert.equal(f.state.usage.length, 1)
  assert.equal(f.rollbacks, 1)
})

test('agent-budget: release is idempotent for reserved/released and conflicts for settled/unknown', async () => {
  const f = fixture()
  const reservation = await f.repo.reserve(reserve())
  const released = await f.repo.release({ ...scope, reservationId: reservation.id })
  assert.equal(released.status, 'released')
  assert.equal(f.state.reservations[0]!.status, 'released')
  assert.ok(f.state.reservations[0]!.settled_at instanceof Date)
  assert.deepEqual(await f.repo.release({ ...scope, reservationId: reservation.id }), released)
  await assert.rejects(f.repo.settle(settle(reservation.id)), { code: 'CONFLICT' })

  const settled = fixture()
  const held = await settled.repo.reserve(reserve())
  await settled.repo.settle(settle(held.id))
  await assert.rejects(settled.repo.release({ ...scope, reservationId: held.id }), { code: 'CONFLICT' })

  const unknown = fixture()
  const odd = await unknown.repo.reserve(reserve())
  unknown.state.reservations[0]!.status = 'unknown'
  await assert.rejects(unknown.repo.release({ ...scope, reservationId: odd.id }), { code: 'CONFLICT' })
  await assert.rejects(unknown.repo.release({ ...scope, reservationId: otherId }), { code: 'NOT_FOUND' })
})

test('agent-budget: usage combines outstanding reservations with attributed usage entries in a read-only transaction', async () => {
  const f = fixture()
  const first = await f.repo.reserve(reserve({ idempotencyKey: 'a' }))
  await f.repo.settle(settle(first.id, { settlementKey: 'sa' }))
  await f.repo.reserve(reserve({ idempotencyKey: 'b' }))
  f.state.usage.push({ id: '50000000-0000-4000-8000-000000000099', session_id: scope.sessionId,
    turn_id: scope.turnId, reservation_id: null, settlement_key: 'manual', usage_kind: 'actual', amount: '3',
    currency: null, details: { quota: 'input_tokens' }, created_at: new Date(now) })
  const used = await f.repo.usage(scope)
  assert.deepEqual(used, { modelCalls: 2, toolCalls: 0, mediaJobs: 0, mediaOutputs: 0,
    inputTokens: 3n, outputTokens: 0n, concurrentMediaJobs: 0,
    estimatedCost: { amount: '0', currency: 'USD', pricingReference: 'pricing-1' } })
  assert.equal(f.readOnly.at(-1), true)
})

test('agent-budget: usage sums fractional cost reservations and settlements at numeric precision', async () => {
  const f = fixture()
  const first = await f.repo.reserve(reserve({ quota: 'estimated_cost', amount: '0.25', currency: 'USD',
    pricingRevision: 'pricing-1', idempotencyKey: 'c1' }))
  await f.repo.settle(settle(first.id, { actualAmount: '0.1', settlementKey: 'cs' }))
  await f.repo.reserve(reserve({ quota: 'estimated_cost', amount: '0.2', currency: 'USD',
    pricingRevision: 'pricing-1', idempotencyKey: 'c2' }))
  f.state.usage.push({ id: '50000000-0000-4000-8000-000000000098', session_id: scope.sessionId,
    turn_id: scope.turnId, reservation_id: null, settlement_key: 'manual-cost', usage_kind: 'actual', amount: '0.05',
    currency: null, details: { quota: 'estimated_cost' }, created_at: new Date(now) })
  const used = await f.repo.usage(scope)
  assert.equal(used.estimatedCost?.amount, '0.35')
  assert.equal(used.estimatedCost?.currency, 'USD')
  assert.equal(used.estimatedCost?.pricingReference, 'pricing-1')
})

test('agent-budget: mismatched owner, terminal/cancelled turn and expired deadline are rejected without writes', async () => {
  for (const wrong of [{ ownerId: otherId }, { sessionId: otherId }, { turnId: otherId }]) {
    const f = fixture()
    await assert.rejects(f.repo.reserve(reserve(wrong)), { code: 'NOT_FOUND' })
    assert.equal(f.state.reservations.length, 0)
  }
  for (const status of ['completed', 'failed', 'cancelled']) {
    const f = fixture()
    f.state.turn.status = status
    await assert.rejects(f.repo.reserve(reserve()), { code: 'NOT_FOUND' })
    assert.equal(f.state.reservations.length, 0)
  }
  const cancelled = fixture()
  cancelled.state.turn.cancel_requested_at = new Date(now)
  await assert.rejects(cancelled.repo.reserve(reserve()), { code: 'NOT_FOUND' })
  const expired = fixture()
  expired.state.turn.deadline_at = new Date(now)
  await assert.rejects(expired.repo.reserve(reserve()), { code: 'NOT_FOUND' })

  const scoped = fixture()
  const reservation = await scoped.repo.reserve(reserve())
  await assert.rejects(scoped.repo.settle(settle(reservation.id, { ownerId: otherId })), { code: 'NOT_FOUND' })
  await assert.rejects(scoped.repo.release({ ...scope, ownerId: otherId, reservationId: reservation.id }), { code: 'NOT_FOUND' })
  await assert.rejects(scoped.repo.usage({ ...scope, ownerId: otherId }), { code: 'NOT_FOUND' })
  await assert.rejects(scoped.repo.usage({ ...scope, turnId: otherId }), { code: 'NOT_FOUND' })
  assert.equal(scoped.state.reservations[0]!.status, 'reserved')
})

test('agent-budget: malformed snapshots, mixed cost metadata and unattributed usage fail closed', async () => {
  const mutations: ((snapshot: any) => void)[] = [
    snapshot => { delete snapshot.maxModelCalls },
    snapshot => { snapshot.maxModelCalls = '2' },
    snapshot => { snapshot.maxInputTokens = 10 },
    snapshot => { snapshot.maxInputTokens = '-1' },
    snapshot => { snapshot.maxOutputTokens = '1.5' },
    snapshot => { snapshot.maxEstimatedCost = { currency: 'USD', amount: '1' } },
    snapshot => { snapshot.maxEstimatedCost = { currency: 'usd', amount: '1', pricingReference: 'pricing-1' } },
    snapshot => { snapshot.maxEstimatedCost = { currency: 'USD', amount: '1.0000000001', pricingReference: 'pricing-1' } },
    snapshot => { snapshot.maxConcurrentMediaJobs = 1.5 },
    snapshot => { snapshot.maxEstimatedCost = undefined },
  ]
  for (const mutate of mutations) {
    const f = fixture()
    mutate(f.state.turn.budget_snapshot)
    await assert.rejects(f.repo.reserve(reserve()), { code: 'UNAVAILABLE' })
    assert.equal(f.state.reservations.length, 0)
  }

  const missing = fixture()
  missing.state.turn.budget_snapshot = null
  await assert.rejects(missing.repo.reserve(reserve()), { code: 'UNAVAILABLE' })

  const mixed = fixture()
  mixed.state.reservations.push({ id: otherId, session_id: scope.sessionId, turn_id: scope.turnId,
    quota: 'estimated_cost', reserved_amount: '0.1', currency: 'EUR', pricing_revision: 'pricing-1',
    status: 'reserved', idempotency_key: 'eur', created_at: new Date(now), settled_at: null })
  await assert.rejects(mixed.repo.reserve(reserve()), { code: 'UNAVAILABLE' })

  const unattributed = fixture()
  unattributed.state.usage.push({ id: otherId, session_id: scope.sessionId, turn_id: scope.turnId,
    reservation_id: null, settlement_key: 'bad', usage_kind: 'actual', amount: '1', currency: null,
    details: {}, created_at: new Date(now) })
  await assert.rejects(unattributed.repo.reserve(reserve()), { code: 'UNAVAILABLE' })
  await assert.rejects(unattributed.repo.usage(scope), { code: 'UNAVAILABLE' })
})

test('agent-budget: standalone unknown Runner model cost without ceiling reads unknown with no fabricated denomination', async () => {
  const f = fixture()
  f.state.turn.budget_snapshot = { ...budget(), maxEstimatedCost: null }
  f.state.usage.push({ id: '50000000-0000-4000-8000-000000000097', session_id: scope.sessionId,
    turn_id: scope.turnId, reservation_id: null, settlement_key: 'media:cost:standalone', usage_kind: 'unknown',
    amount: '0', currency: null, details: { quota: 'estimated_cost', unknownCost: true,
      reason: 'media_provider_cost_unknown' }, created_at: new Date(now) })
  const used = await f.repo.usage(scope)
  assert.equal(used.estimatedCost, null)
  assert.equal(used.modelCalls, 0)
  assert.equal(f.readOnly.at(-1), true)
})

test('agent-budget: unknown model fee keeps a known media fee from being reported as certain', async () => {
  const f = fixture()
  f.state.reservations.push({ id: '40000000-0000-4000-8000-000000000098', session_id: scope.sessionId,
    turn_id: scope.turnId, tool_call_id: toolCallId, round_id: null, quota: 'estimated_cost',
    reserved_amount: '5', currency: 'USD', pricing_revision: 'pricing-1', status: 'reserved',
    idempotency_key: 'known-media', created_at: new Date(now), settled_at: null })
  f.state.usage.push({ id: '50000000-0000-4000-8000-000000000096', session_id: scope.sessionId,
    turn_id: scope.turnId, reservation_id: null, settlement_key: 'recovery:model', usage_kind: 'unknown',
    amount: '2', currency: 'USD', details: { quota: 'estimated_cost', reason: 'cancel_model_outcome_unknown' },
    created_at: new Date(now) })
  assert.equal((await f.repo.usage(scope)).estimatedCost, null)
})
