import assert from 'node:assert/strict'
import test from 'node:test'
import { agentCoreDecimal, type AgentCoreClient, type AgentCoreTransaction } from './agent-core'
import { AgentRuntimeRepository, type AgentTurnExecutionFence, type AgentTurnLeaseIdentity, type AgentTurnScope } from './agent-runtime'

const scope: AgentTurnScope = { ownerId: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000001', turnId: '30000000-0000-4000-8000-000000000001' }
const now = Date.parse('2026-11-17T08:00:00Z')
const token = (value: string) => agentCoreDecimal(value)
const claim = { ...scope, leaseOwner: 'worker-a', leaseDurationMs: 1000 }
const held: AgentTurnLeaseIdentity = { ...scope, leaseOwner: 'worker-a', fencingToken: token('1') }
const fence: AgentTurnExecutionFence = { ...held, expectedInputRevision: token('1') }
const CLAIMABLE = ['queued', 'running', 'waiting_tools', 'waiting_approval']
function initial() {
  return {
    actor: { id: scope.ownerId, active: true },
    session: { id: scope.sessionId, owner_id: scope.ownerId, active_turn_id: scope.turnId as string | null, archived_at: null as Date | null, next_event_cursor: '3' },
    turn: { id: scope.turnId, session_id: scope.sessionId, engine_version: 'agent-core-v1', status: 'queued',
      revision: '1', input_revision: '1', fencing_token: '0', lease_owner: null as string | null, lease_until: null as Date | null,
      cancel_requested_at: null as Date | null, terminal_at: null as Date | null, deadline_at: new Date(now + 10000), error: null },
    events: [] as { cursor: string; revision: string; payload: string }[], effects: 0,
    tools: [] as { id:string; status:string; has_result:boolean }[], approvals: [] as {status:string}[], reservations: [] as {status:string}[], rounds: [] as {status:string}[],
  }
}
// This is a deliberately limited in-memory transaction/SQL-result model. It
// checks calls, predicates and rollback propagation; it is NOT PostgreSQL SQL,
// trigger, microsecond precision, isolation or concurrency validation. Real PG
// scenarios are source-only in tests/integration/agent-runtime-pg.test.ts.
function fixture() {
  let state = initial(), dbTime = now
  const calls: { sql: string; args: unknown[] }[] = []
  let commits = 0, rollbacks = 0
  let fail: RegExp | undefined
  const copy = <T>(value: T): T => structuredClone(value)
  const matches = (args: unknown[]) => state.turn.session_id === args[0] && state.turn.id === args[1]
  const executable = () => state.turn.cancel_requested_at === null && state.turn.deadline_at.getTime() > dbTime
  const live = () => state.turn.lease_until !== null && state.turn.lease_until.getTime() > dbTime
  const client = { async query(raw: string, args: unknown[] = []) {
    const sql = raw.replace(/\s+/g, ' ').trim()
    calls.push({ sql, args })
    const binds = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]))
    assert.equal(binds.length ? Math.max(...binds) : 0, args.length)
    if (fail?.test(sql)) throw new Error('injected SQL failure')
    const t = state.turn
    if (sql.includes('FROM users WHERE')) return { rows: state.actor.id === args[0] ? [copy(state.actor)] : [] }
    if (sql.startsWith('SELECT id,owner_id')) return { rows: state.session.owner_id === args[0] && state.session.id === args[1] ? [copy(state.session)] : [] }
    if (sql.startsWith('SELECT * FROM agent_turns')) return { rows: matches(args) ? [copy(t)] : [] }
    if (sql.startsWith('UPDATE agent_turns SET lease_owner=$3')) {
      if (!matches(args) || t.engine_version !== 'agent-core-v1' || !CLAIMABLE.includes(t.status) || live() || !executable()) return { rows: [] }
      t.lease_owner = String(args[2]); t.lease_until = new Date(Math.min(t.deadline_at.getTime(), dbTime + Number(args[3])))
      t.fencing_token = String(BigInt(t.fencing_token) + 1n)
      if (t.status !== 'running') t.revision = String(BigInt(t.revision) + 1n)
      t.status = 'running'
      return { rows: [copy(t)] }
    }
    if (sql.startsWith('UPDATE agent_turns SET lease_until=')) {
      if (!matches(args) || t.engine_version !== 'agent-core-v1' || t.status !== 'running' || t.lease_owner !== args[2] || t.fencing_token !== args[3] || !live() || !executable()) return { rows: [] }
      t.lease_until = new Date(Math.min(t.deadline_at.getTime(), dbTime + Number(args[4])))
      return { rows: [copy(t)] }
    }
    if (sql.startsWith('UPDATE agent_turns SET lease_owner=NULL')) {
      if (!matches(args) || t.engine_version !== 'agent-core-v1' || t.lease_owner !== args[2] || t.fencing_token !== args[3]) return { rows: [] }
      t.lease_owner = null; t.lease_until = null
      return { rows: [{ id: t.id }] }
    }
    if (sql.startsWith('SELECT t.* FROM agent_turns t')) {
      const s = state.session
      return { rows: s.owner_id === args[0] && s.id === args[1] && t.id === args[2] && t.session_id === s.id && s.active_turn_id === t.id && s.archived_at === null && state.actor.active && t.engine_version === 'agent-core-v1' && t.status === 'running' && t.lease_owner === args[3] && t.fencing_token === args[4] && live() && executable() && t.input_revision === args[5] ? [copy(t)] : [] }
    }
    if (sql.startsWith('UPDATE agent_sessions SET next_event_cursor=')) {
      const cursor = state.session.next_event_cursor
      state.session.next_event_cursor = String(BigInt(cursor) + 1n)
      return { rows: [{ cursor }] }
    }
    if (sql.startsWith('INSERT INTO agent_session_events')) {
      state.events.push({ cursor: String(args[2]), revision: String(args[3]), payload: String(args[4]) })
      return { rows: [] }
    }
    if (sql.startsWith('SELECT x.id,x.status')) return { rows: copy(state.tools) }
    if (sql.startsWith('SELECT status FROM agent_approvals')) return { rows: copy(state.approvals) }
    if (sql.startsWith('SELECT status FROM agent_budget_reservations')) return { rows: copy(state.reservations) }
    if (sql.startsWith('SELECT status FROM agent_model_rounds')) return { rows: copy(state.rounds) }
    if (sql.startsWith('UPDATE agent_turns SET status=$6')) {
      if (!matches(args) || t.status!=='running' || t.lease_owner!==args[2] || t.fencing_token!==args[3] || t.input_revision!==args[4] || !live() || !executable()) return {rows:[]}
      t.status=String(args[5]); t.error=args[6] ? JSON.parse(String(args[6])) : null
      t.terminal_at=args[7] ? new Date(dbTime) : null; t.lease_owner=null; t.lease_until=null; t.revision=String(BigInt(t.revision)+1n)
      return {rows:[copy(t)]}
    }
    if (sql.startsWith('UPDATE agent_sessions SET active_turn_id=NULL')) {
      if (state.session.id!==args[0] || state.session.owner_id!==args[1] || state.session.active_turn_id!==args[2]) return {rows:[],rowCount:0}
      state.session.active_turn_id=null; return {rows:[],rowCount:1}
    }
    if (sql === 'INSERT INTO fixture_effect') { state.effects++; return { rows: [] } }
    throw new Error(`unexpected fixture SQL: ${sql}`)
  } } as unknown as AgentCoreClient
  const tx: AgentCoreTransaction = async (work, readOnly = false) => {
    assert.equal(readOnly, false)
    const before = copy(state)
    try { const value = await work(client); commits++; return value }
    catch (error) { state = before; rollbacks++; throw error }
  }
  return { repo: new AgentRuntimeRepository(tx), calls, get state() { return state }, get commits() { return commits }, get rollbacks() { return rollbacks },
    setTime(value: number) { dbTime = value }, failOn(value: RegExp) { fail = value } }
}

function assertNoLeasePublicChanges(f: ReturnType<typeof fixture>) {
  assert.equal(f.state.turn.revision, '2')
  assert.equal(f.state.session.next_event_cursor, '4')
  assert.equal(f.state.events.length, 1)
  assert.equal(f.state.turn.input_revision, '1')
  assert.ok(f.calls.every(c => !/outbox|consumed|ACK/i.test(c.sql)))
}

test('agent-runtime: fresh queued claim locks actor -> session -> turn, advances fence/revision and emits allowlisted event atomically', async () => {
  const f = fixture()
  const result = await f.repo.claimTurnLease(claim)
  assert.deepEqual(result, { ...held, leaseUntil: new Date(now + 1000).toISOString(), revision: '2', inputRevision: '1' })
  assert.match(f.calls[0]!.sql, /FROM users WHERE id=\$1 FOR NO KEY UPDATE$/)
  assert.match(f.calls[1]!.sql, /WHERE owner_id=\$1 AND id=\$2 FOR UPDATE$/)
  assert.match(f.calls[2]!.sql, /WHERE session_id=\$1 AND id=\$2 FOR UPDATE$/)
  assert.deepEqual(f.calls.slice(0, 3).map(c => c.args), [[scope.ownerId], [scope.ownerId, scope.sessionId], [scope.sessionId, scope.turnId]])
  const sql = f.calls[3]!.sql
  assert.match(sql, /fencing_token=fencing_token\+1/)
  assert.match(sql, /status='running',revision=revision\+CASE WHEN status='running' THEN 0 ELSE 1 END/)
  assert.match(sql, /status IN \('queued','running','waiting_tools','waiting_approval'\)/)
  assert.match(sql, /lease_until IS NULL OR lease_until<=clock_timestamp\(\)/)
  assert.match(sql, /cancel_requested_at IS NULL AND clock_timestamp\(\)<deadline_at/)
  assert.match(sql, /LEAST\(deadline_at,clock_timestamp\(\)\+\$4::int\*interval '1 millisecond'\)/)
  assert.deepEqual(f.state.events[0], { cursor: '3', revision: '2', payload: JSON.stringify({ turn: {
    id: scope.turnId, sessionId: scope.sessionId, status: 'running', engineVersion: 'agent-core-v1', revision: '2', inputRevision: '1',
    cancelRequestedAt: null, terminalAt: null, deadlineAt: new Date(now + 10000).toISOString(), error: null,
  } }) })
  assertNoLeasePublicChanges(f); assert.equal(f.commits, 1)
})

for (const leaseOwner of ['worker-a', 'worker-b']) {
  test(`agent-runtime: active lease cannot be stolen by ${leaseOwner}; exact expiry reclaim increments token once without event`, async () => {
    const f = fixture()
    await f.repo.claimTurnLease(claim)
    assert.equal(await f.repo.claimTurnLease({ ...claim, leaseOwner }), null)
    f.setTime(now + 1000)
    const replacement = await f.repo.claimTurnLease({ ...claim, leaseOwner })
    assert.equal(replacement?.fencingToken, '2'); assert.equal(replacement?.leaseOwner, leaseOwner)
    assertNoLeasePublicChanges(f)
  })
}

test('agent-runtime: running turn with no lease is claimable; release and same-owner reclaim also require next token', async () => {
  const f = fixture()
  f.state.turn.status = 'running'; f.state.turn.revision = '2'
  const first = await f.repo.claimTurnLease(claim)
  assert.equal(first?.fencingToken, '1'); assert.equal(f.state.events.length, 0)
  assert.equal(await f.repo.releaseTurnLease(held), true)
  assert.equal(await f.repo.releaseTurnLease(held), false)
  assert.equal((await f.repo.claimTurnLease(claim))?.fencingToken, '2')
  assert.equal(f.state.turn.revision, '2'); assert.equal(f.state.events.length, 0)
})

for (const status of ['queued', 'waiting_tools', 'waiting_approval'] as const) {
  test(`agent-runtime: ${status} claim enters running, advances revision once and publishes exactly one turn.updated`, async () => {
    const f = fixture()
    f.state.turn.status = status; f.state.turn.revision = '5'
    const claimed = await f.repo.claimTurnLease(claim)
    assert.deepEqual(claimed, { ...held, leaseUntil: new Date(now + 1000).toISOString(), revision: '6', inputRevision: '1' })
    assert.equal(f.state.turn.status, 'running'); assert.equal(f.state.turn.revision, '6')
    assert.equal(f.state.session.next_event_cursor, '4'); assert.equal(f.state.events.length, 1)
    assert.deepEqual(f.state.events[0], { cursor: '3', revision: '6', payload: JSON.stringify({ turn: {
      id: scope.turnId, sessionId: scope.sessionId, status: 'running', engineVersion: 'agent-core-v1', revision: '6', inputRevision: '1',
      cancelRequestedAt: null, terminalAt: null, deadlineAt: new Date(now + 10000).toISOString(), error: null,
    } }) })
    assert.equal(f.calls.filter(c => c.sql.startsWith('INSERT INTO agent_session_events')).length, 1)
    assert.ok(f.calls.every(c => !/outbox|consumed|ACK/i.test(c.sql)))
  })
}

const blockedWaitingClaims: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ['cancel intent', f => { f.state.turn.cancel_requested_at = new Date(now) }],
  ['deadline equality', f => { f.state.turn.deadline_at = new Date(now) }],
  ['foreign owner session', f => { f.state.session.owner_id = '00000000-0000-4000-8000-000000000099' }],
]
for (const status of ['waiting_tools', 'waiting_approval'] as const) {
  for (const [name, mutate] of blockedWaitingClaims) {
    test(`agent-runtime: ${status} claim still rejects ${name} without revision, event or lease`, async () => {
      const f = fixture(); f.state.turn.status = status; mutate(f)
      const before = structuredClone(f.state)
      assert.equal(await f.repo.claimTurnLease(claim), null)
      assert.deepEqual(f.state, before)
      assert.equal(f.commits, 1); assert.equal(f.rollbacks, 0)
    })
  }
}

const invalidClaimCases: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ['inactive user', f => { f.state.actor.active = false }],
  ['archived session', f => { f.state.session.archived_at = new Date(now) }],
  ['wrong active pointer', f => { f.state.session.active_turn_id = null }],
  ['wrong engine', f => { f.state.turn.engine_version = 'legacy' }],
  ...['completed', 'failed', 'cancelled'].map(status => [status, (f: ReturnType<typeof fixture>) => { f.state.turn.status = status }] as [string, (f: ReturnType<typeof fixture>) => void]),
  ['cancel intent', f => { f.state.turn.cancel_requested_at = new Date(now) }],
  ['deadline equality', f => { f.state.turn.deadline_at = new Date(now) }],
  ['deadline past', f => { f.state.turn.deadline_at = new Date(now - 1) }],
]
for (const [name, mutate] of invalidClaimCases) {
  test(`agent-runtime: claim leaves ${name} unclaimed for future recovery`, async () => {
    const f = fixture(); mutate(f)
    const before = structuredClone(f.state)
    assert.equal(await f.repo.claimTurnLease(claim), null)
    assert.deepEqual(f.state, before)
  })
}
for (const key of ['ownerId', 'sessionId', 'turnId'] as const) {
  test(`agent-runtime: explicit ${key} scope mismatch rejects claim, renewal, release and write`, async () => {
    const f = fixture(); await f.repo.claimTurnLease(claim)
    const wrong = { [key]: '00000000-0000-4000-8000-000000000099' }
    assert.equal(await f.repo.claimTurnLease({ ...claim, ...wrong }), null)
    assert.equal(await f.repo.renewTurnLease({ ...held, ...wrong, leaseDurationMs: 1000 }), null)
    assert.equal(await f.repo.releaseTurnLease({ ...held, ...wrong }), false)
    await assert.rejects(f.repo.withTurnLease({ ...fence, ...wrong }, async c => { await c.query('INSERT INTO fixture_effect') }), { code: 'LEASE_REJECTED' })
    assert.equal(f.state.effects, 0); assertNoLeasePublicChanges(f)
  })
}

test('agent-runtime: renewal uses DB clock and token, ignores steering/public revisions and does not advance fence/event', async () => {
  const f = fixture(); await f.repo.claimTurnLease(claim)
  f.state.turn.revision = '8'; f.state.turn.input_revision = '4'
  f.setTime(now + 500)
  const renewed = await f.repo.renewTurnLease({ ...held, leaseDurationMs: 2000 })
  assert.equal(renewed?.leaseUntil, new Date(now + 2500).toISOString())
  assert.equal(renewed?.fencingToken, '1'); assert.equal(renewed?.revision, '8'); assert.equal(renewed?.inputRevision, '4')
  const sql = f.calls.at(-1)!.sql
  assert.match(sql, /lease_owner=\$3 AND fencing_token=\$4 AND clock_timestamp\(\)<lease_until/)
  assert.match(sql, /cancel_requested_at IS NULL AND clock_timestamp\(\)<deadline_at/)
  assert.doesNotMatch(sql, /revision=|input_revision=|fencing_token=fencing_token/)
  assert.equal(f.state.events.length, 1); assert.equal(f.state.session.next_event_cursor, '4')
  await assert.rejects(f.repo.withTurnLease(fence, async () => assert.fail('steering must fence old input')), { code: 'LEASE_REJECTED' })
  assert.equal(await f.repo.withTurnLease({ ...fence, expectedInputRevision: token('4') }, async () => 'current'), 'current')
})

for (const kind of ['expiry equality', 'expiry past', 'cancel', 'deadline'] as const) {
  test(`agent-runtime: ${kind} rejects renewal and effects, but permits own-lease release`, async () => {
    const f = fixture(); await f.repo.claimTurnLease(claim)
    if (kind === 'expiry equality') f.setTime(now + 1000)
    if (kind === 'expiry past') f.setTime(now + 1001)
    if (kind === 'cancel') f.state.turn.cancel_requested_at = new Date(now)
    if (kind === 'deadline') f.state.turn.deadline_at = new Date(now)
    const before = structuredClone(f.state.turn)
    assert.equal(await f.repo.renewTurnLease({ ...held, leaseDurationMs: 1000 }), null)
    await assert.rejects(f.repo.withTurnLease(fence, async () => assert.fail('blocked effect')), { code: 'LEASE_REJECTED' })
    assert.equal(await f.repo.releaseTurnLease(held), true)
    assert.deepEqual(f.state.turn, { ...before, lease_owner: null, lease_until: null })
    assertNoLeasePublicChanges(f)
  })
}

for (const leaseOwner of ['worker-a', 'worker-b']) {
  test(`agent-runtime: old token cannot renew/release/write after ${leaseOwner} replacement`, async () => {
    const f = fixture(); await f.repo.claimTurnLease(claim); f.setTime(now + 1000)
    const replacement = await f.repo.claimTurnLease({ ...claim, leaseOwner })
    assert.ok(replacement)
    assert.equal(await f.repo.renewTurnLease({ ...held, leaseDurationMs: 1000 }), null)
    assert.equal(await f.repo.releaseTurnLease(held), false)
    await assert.rejects(f.repo.withTurnLease(fence, async () => assert.fail('stale writer')), { code: 'LEASE_REJECTED' })
    const impostor = { ...replacement, leaseOwner: `${leaseOwner}-other` }
    assert.equal(await f.repo.renewTurnLease({ ...impostor, leaseDurationMs: 1000 }), null)
    assert.equal(await f.repo.releaseTurnLease(impostor), false)
    await assert.rejects(f.repo.withTurnLease({ ...impostor, expectedInputRevision: token('1') }, async () => assert.fail('wrong owner')), { code: 'LEASE_REJECTED' })
    assert.equal(f.state.turn.fencing_token, '2'); assert.equal(f.state.turn.lease_owner, leaseOwner)
  })
}

test('agent-runtime: cleanup locks disabled actor and archived/non-active session and preserves cancellation, state and pointer', async () => {
  const f = fixture(); await f.repo.claimTurnLease(claim)
  f.state.actor.active = false; f.state.session.archived_at = new Date(now); f.state.session.active_turn_id = null
  f.state.turn.cancel_requested_at = new Date(now); f.setTime(now + 10000)
  const before = structuredClone(f.state)
  assert.equal(await f.repo.renewTurnLease({ ...held, leaseDurationMs: 1000 }), null)
  assert.equal(await f.repo.releaseTurnLease(held), true)
  assert.deepEqual(f.state, { ...before, turn: { ...before.turn, lease_owner: null, lease_until: null } })
  const sql = f.calls.at(-1)!.sql
  assert.match(sql, /engine_version='agent-core-v1' AND lease_owner=\$3 AND fencing_token=\$4/)
  assert.doesNotMatch(sql, /status=|cancel_requested_at=|active_turn_id=|revision=|clock_timestamp\(\)</)
})

test('agent-runtime: both execution guards check scope, actor, pointer, engine, owner, token, strict DB expiry, intent and input', async () => {
  const f = fixture(); await f.repo.claimTurnLease(claim)
  assert.equal(await f.repo.withTurnLease(fence, async (c, current) => {
    assert.equal(current.inputRevision, '1'); await c.query('INSERT INTO fixture_effect'); return 'saved'
  }), 'saved')
  const guards = f.calls.filter(c => c.sql.startsWith('SELECT t.*'))
  assert.equal(guards.length, 2)
  for (const guard of guards) {
    assert.match(guard.sql, /s.owner_id=\$1 AND s.id=\$2 AND t.id=\$3 AND s.active_turn_id=t.id AND s.archived_at IS NULL/)
    assert.match(guard.sql, /u.status='active' AND u.deleted_at IS NULL AND t.engine_version='agent-core-v1' AND t.status='running'/)
    assert.match(guard.sql, /t.lease_owner=\$4 AND t.fencing_token=\$5 AND clock_timestamp\(\)<t.lease_until/)
    assert.match(guard.sql, /t.cancel_requested_at IS NULL AND clock_timestamp\(\)<t.deadline_at AND t.input_revision=\$6/)
    assert.deepEqual(guard.args, [scope.ownerId, scope.sessionId, scope.turnId, 'worker-a', '1', '1'])
  }
  assert.equal(f.state.effects, 1); assertNoLeasePublicChanges(f)
})

for (const kind of ['lease expiry', 'deadline expiry', 'input revision', 'cancel intent', 'active pointer', 'engine', 'actor', 'status'] as const) {
  test(`agent-runtime: final guard rejects ${kind} during callback and mock transaction rolls back all SQL`, async () => {
    const f = fixture(); await f.repo.claimTurnLease(claim)
    const before = structuredClone(f.state)
    await assert.rejects(f.repo.withTurnLease(fence, async c => {
      await c.query('INSERT INTO fixture_effect')
      if (kind === 'lease expiry') f.setTime(now + 1000)
      if (kind === 'deadline expiry') f.setTime(now + 10000)
      // These direct mutations simulate forbidden control-row SQL, to check
      // defense in depth. They are not permitted callback operations.
      if (kind === 'input revision') f.state.turn.input_revision = '2'
      if (kind === 'cancel intent') f.state.turn.cancel_requested_at = new Date(now)
      if (kind === 'active pointer') f.state.session.active_turn_id = null
      if (kind === 'engine') f.state.turn.engine_version = 'legacy'
      if (kind === 'actor') f.state.actor.active = false
      if (kind === 'status') f.state.turn.status = 'waiting_tools'
    }), { code: 'LEASE_REJECTED' })
    assert.deepEqual(f.state, before); assert.equal(f.rollbacks, 1)
  })
}

test('agent-runtime: event SQL failure rolls back claim/fence/revision/cursor in mock transaction and propagates error', async () => {
  const f = fixture(), before = structuredClone(f.state)
  f.failOn(/INSERT INTO agent_session_events/)
  await assert.rejects(f.repo.claimTurnLease(claim), /injected SQL failure/)
  assert.deepEqual(f.state, before); assert.equal(f.rollbacks, 1); assert.equal(f.commits, 0)
})

test('agent-runtime: callback SQL failure or application error propagates and rolls back earlier mock writes', async () => {
  for (const sqlFailure of [true, false]) {
    const f = fixture(); await f.repo.claimTurnLease(claim)
    const before = structuredClone(f.state)
    if (sqlFailure) f.failOn(/INSERT INTO failing_effect/)
    await assert.rejects(f.repo.withTurnLease(fence, async c => {
      await c.query('INSERT INTO fixture_effect')
      if (sqlFailure) await c.query('INSERT INTO failing_effect')
      throw new Error('callback rejected')
    }), sqlFailure ? /injected SQL failure/ : /callback rejected/)
    assert.deepEqual(f.state, before); assert.equal(f.rollbacks, 1)
  }
})

test('agent-runtime: lease is capped at immutable database deadline and bigint tokens retain precision', async () => {
  const f = fixture()
  f.state.turn.fencing_token = '9007199254740993'
  const lease = await f.repo.claimTurnLease({ ...claim, leaseDurationMs: 20000 })
  assert.equal(lease?.fencingToken, '9007199254740994')
  assert.equal(lease?.leaseUntil, new Date(now + 10000).toISOString())
})

test('agent-runtime: rejects empty owner, invalid durations and zero token before opening transaction', () => {
  const f = fixture()
  for (const leaseDurationMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    assert.throws(() => f.repo.claimTurnLease({ ...claim, leaseDurationMs }), { code: 'INVALID_INPUT' })
    assert.throws(() => f.repo.renewTurnLease({ ...held, leaseDurationMs }), { code: 'INVALID_INPUT' })
  }
  assert.throws(() => f.repo.claimTurnLease({ ...claim, leaseOwner: '  ' }), { code: 'INVALID_INPUT' })
  assert.throws(() => f.repo.releaseTurnLease({ ...held, fencingToken: token('0') }), { code: 'INVALID_INPUT' })
  assert.equal(f.calls.length, 0); assert.equal(f.commits, 0)
})

test('agent-runtime: successful completion independently guards terminal dependencies and commits full public DTO/pointer/lease atomically',async()=>{
  const f=fixture();await f.repo.claimTurnLease(claim)
  f.state.tools.push({id:'tool',status:'completed',has_result:true});f.state.reservations.push({status:'settled'});f.state.rounds.push({status:'completed'})
  const result=await f.repo.transitionWithTurnLease(fence,{to:'completed'},async c=>{await c.query('INSERT INTO fixture_effect');return 'checkpoint'})
  assert.equal(result.work,'checkpoint');assert.equal(result.turn.status,'completed');assert.equal(f.state.session.active_turn_id,null);assert.equal(f.state.turn.lease_owner,null);assert.equal(f.state.turn.terminal_at?.getTime(),now);assert.equal(f.state.effects,1)
  const payload=JSON.parse(f.state.events.at(-1)!.payload).turn
  assert.deepEqual(payload,result.turn);assert.equal(payload.sessionId,scope.sessionId);assert.equal(payload.revision,'3');assert.equal(payload.inputRevision,'1');assert.equal(payload.engineVersion,'agent-core-v1');assert.equal(payload.deadlineAt,new Date(now+10000).toISOString())
  const update=f.calls.find(call=>call.sql.startsWith('UPDATE agent_turns SET status=$6'))!.sql
  assert.match(update,/lease_owner=\$3 AND fencing_token=\$4 AND clock_timestamp\(\)<lease_until/);assert.match(update,/input_revision=\$5/)
})
for(const dependency of ['unpaired tool','running tool','reserved budget','unknown budget','pending approval','running round']) {
  test(`agent-runtime: terminal transition rejects ${dependency} and rolls back callback effects`,async()=>{
    const f=fixture();await f.repo.claimTurnLease(claim)
    if(dependency==='unpaired tool')f.state.tools.push({id:'tool',status:'completed',has_result:false})
    if(dependency==='running tool')f.state.tools.push({id:'tool',status:'executing',has_result:false})
    if(dependency==='reserved budget')f.state.reservations.push({status:'reserved'})
    if(dependency==='unknown budget')f.state.reservations.push({status:'unknown'})
    if(dependency==='pending approval')f.state.approvals.push({status:'pending'})
    if(dependency==='running round')f.state.rounds.push({status:'running'})
    const before=structuredClone(f.state)
    await assert.rejects(f.repo.transitionWithTurnLease(fence,{to:'completed'},async c=>c.query('INSERT INTO fixture_effect')),{code:'TRANSITION_REJECTED'})
    assert.deepEqual(f.state,before)
  })
}
test('agent-runtime: media handoff requires durable waiting dependency, releases lease, preserves active pointer',async()=>{
  const f=fixture();await f.repo.claimTurnLease(claim)
  await assert.rejects(f.repo.transitionWithTurnLease(fence,{to:'waiting_tools'},async()=>undefined),{code:'TRANSITION_REJECTED'})
  f.state.tools.push({id:'tool',status:'waiting_external',has_result:false})
  const result=await f.repo.transitionWithTurnLease(fence,{to:'waiting_tools'},async()=>undefined)
  assert.equal(result.turn.status,'waiting_tools');assert.equal(f.state.turn.lease_owner,null);assert.equal(f.state.turn.terminal_at,null);assert.equal(f.state.session.active_turn_id,scope.turnId)
})
test('agent-runtime: terminal event failure rolls back checkpoint, pointer, revision and lease together',async()=>{
  const f=fixture();await f.repo.claimTurnLease(claim);const before=structuredClone(f.state);f.failOn(/INSERT INTO agent_session_events/)
  await assert.rejects(f.repo.transitionWithTurnLease(fence,{to:'completed'},async c=>c.query('INSERT INTO fixture_effect')),/injected SQL failure/);assert.deepEqual(f.state,before)
})
test('agent-runtime: final running fence still rejects cancellation during terminal callback',async()=>{
  const f=fixture();await f.repo.claimTurnLease(claim);const before=structuredClone(f.state)
  await assert.rejects(f.repo.transitionWithTurnLease(fence,{to:'completed'},async c=>{await c.query('INSERT INTO fixture_effect');f.state.turn.cancel_requested_at=new Date(now)}),{code:'LEASE_REJECTED'});assert.deepEqual(f.state,before)
})
