import assert from 'node:assert/strict'
import test from 'node:test'
import { appendAgentMediaProposalToolCall, createPendingAgentMediaApproval, expireAgentToolApproval, readAgentToolApproval } from './agent-media-proposal'
import type { AgentCoreClient } from './agent-core'
import { canvasAgentRequestDigest } from './canvas-agent'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ownerId = uuid(1), sessionId = uuid(2), turnId = uuid(3), roundId = uuid(4), toolCallId = uuid(5)
const reservationId = uuid(6), approvalId = uuid(7)
const now = Date.parse('2026-11-17T08:00:00Z')
const args = { modelRevisionId: 'media-revision', prompt: 'draw' }
const argsHash = canvasAgentRequestDigest(args)
const scope = { ownerId, sessionId, turnId }
const toolInput = { scope, roundId, providerCallId: 'call-1', toolName: 'generate_image__v1', toolSchemaVersion: 2,
  arguments: args, argumentsHash: argsHash, idempotencyKey: 'idem-1' }
const approvalInput = { scope, toolCallId, argumentsHash: argsHash, modelRevision: 'language-revision',
  pricingRevision: 'price-v1', reservationId }

interface ToolRow {
  id: string; session_id: string; turn_id: string; round_id: string; position: number; provider_call_id: string
  tool_name: string; tool_schema_version: number; arguments: Record<string, unknown>; arguments_hash: string
  status: string; idempotency_key: string
}
interface ItemRow {
  id: string; session_id: string; turn_id: string; sequence: string; item_type: string; tool_call_id: string | null
  payload: Record<string, unknown>; content_digest: string; created_at: Date
}
interface ApprovalRow {
  id: string; session_id: string; turn_id: string; tool_call_id: string; arguments_hash: string; model_revision: string
  pricing_revision: string; reservation_id: string; status: string; expires_at: Date; resolved_by: string | null
  resolved_at: Date | null; decision_revision?: string | null
}
interface EventRow {
  session_id: string; turn_id: string; cursor: string; entity_revision: string; item_sequence: string | null
  event_type: string; payload: Record<string, unknown>
}
interface State {
  session: { id: string; owner_id: string; next_item_sequence: string; next_event_cursor: string }
  turn: { id: string; session_id: string; revision: string; deadline_at: Date }
  tools: ToolRow[]; items: ItemRow[]; approvals: ApprovalRow[]; events: EventRow[]
}

function initial(): State {
  return {
    session: { id: sessionId, owner_id: ownerId, next_item_sequence: '1', next_event_cursor: '1' },
    turn: { id: turnId, session_id: sessionId, revision: '2', deadline_at: new Date(now + 10 * 60_000) },
    tools: [], items: [], approvals: [], events: [],
  }
}

// Deliberately limited in-memory SQL model: it verifies statement shape, bound
// parameters, ordering, replay behaviour and public projections. It is NOT
// PostgreSQL SQL, isolation or concurrency validation, and it never runs a
// database. Every statement is dispatched so replay paths can be proven to issue
// no INSERT/event at all.
function fixture(seed = initial()) {
  const state = seed
  let dbTime = now
  const calls: { sql: string; args: unknown[] }[] = []
  const copy = <T>(value: T): T => structuredClone(value)
  const at = () => new Date(dbTime)
  const arg = (values: unknown[], index: number) => String(values[index])
  const nextOf = (rows: ToolRow[]) => Math.max(-1, ...rows.map(row => row.position)) + 1
  const client = {
    async query(raw: string, values: unknown[] = []) {
      const sql = raw.replace(/\s+/g, ' ').trim()
      calls.push({ sql, args: values })
      const binds = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]))
      assert.equal(binds.length ? Math.max(...binds) : 0, values.length)
      if (sql.startsWith('SELECT id FROM agent_tool_calls')) {
        return { rows: copy(state.tools.filter(tool => tool.session_id === arg(values, 0) && tool.turn_id === arg(values, 1)
          && tool.idempotency_key === arg(values, 2)).map(tool => ({ id: tool.id }))) }
      }
      if (sql.startsWith('INSERT INTO agent_tool_calls')) {
        assert.match(sql, /'waiting_approval'/, 'proposal inserts are always waiting_approval')
        const sameRound = state.tools.filter(tool => tool.session_id === arg(values, 0) && tool.turn_id === arg(values, 1)
          && tool.round_id === arg(values, 2))
        const tool: ToolRow = { id: `tool-${state.tools.length}`, session_id: arg(values, 0), turn_id: arg(values, 1),
          round_id: arg(values, 2), position: nextOf(sameRound), provider_call_id: arg(values, 3), tool_name: arg(values, 4),
          tool_schema_version: Number(values[5]), arguments: JSON.parse(String(values[6])), arguments_hash: arg(values, 7),
          status: 'waiting_approval', idempotency_key: arg(values, 8) }
        state.tools.push(tool)
        return { rows: [{ id: tool.id }] }
      }
      if (sql.startsWith('SELECT revision::text AS revision FROM agent_turns')) {
        return { rows: state.turn.id === arg(values, 1) && state.turn.session_id === arg(values, 0)
          ? [{ revision: state.turn.revision }] : [] }
      }
      if (sql.startsWith('UPDATE agent_sessions SET next_item_sequence=')) {
        const sequence = state.session.next_item_sequence
        state.session.next_item_sequence = String(BigInt(sequence) + 1n)
        return { rows: [{ sequence }] }
      }
      if (sql.startsWith('INSERT INTO agent_items')) {
        const item: ItemRow = { id: `item-${state.items.length}`, session_id: arg(values, 0), turn_id: arg(values, 1),
          sequence: arg(values, 2), item_type: arg(values, 3), tool_call_id: values[4] == null ? null : String(values[4]),
          payload: JSON.parse(String(values[5])), content_digest: String(values[6]), created_at: at() }
        state.items.push(item)
        return { rows: [copy(item)] }
      }
      if (sql.startsWith('UPDATE agent_sessions SET next_event_cursor=')) {
        const cursor = state.session.next_event_cursor
        state.session.next_event_cursor = String(BigInt(cursor) + 1n)
        return { rows: [{ cursor }] }
      }
      if (sql.startsWith('INSERT INTO agent_session_events')) {
        const joined = sql.includes('FROM agent_turns t')
        state.events.push({ session_id: arg(values, 0), turn_id: arg(values, 1), cursor: arg(values, 2),
          entity_revision: joined ? state.turn.revision : arg(values, 3),
          item_sequence: joined && values[3] != null ? String(values[3]) : null,
          event_type: arg(values, 4), payload: JSON.parse(String(values[5])) })
        return { rows: [] }
      }
      if (sql.startsWith('SELECT id FROM agent_approvals')) {
        return { rows: copy(state.approvals.filter(approval => approval.session_id === arg(values, 0) && approval.turn_id === arg(values, 1)
          && approval.tool_call_id === arg(values, 2) && approval.arguments_hash === arg(values, 3)).map(approval => ({ id: approval.id }))) }
      }
      if (sql.startsWith('INSERT INTO agent_approvals')) {
        if (state.turn.id !== arg(values, 1) || state.turn.session_id !== arg(values, 0)) return { rows: [] }
        const approval: ApprovalRow = { id: approvalId, session_id: arg(values, 0), turn_id: arg(values, 1),
          tool_call_id: arg(values, 2), arguments_hash: arg(values, 3), model_revision: arg(values, 4),
          pricing_revision: arg(values, 5), reservation_id: arg(values, 6), status: 'pending',
          expires_at: new Date(Math.min(state.turn.deadline_at.getTime(), dbTime + 30 * 60_000)),
          resolved_by: null, resolved_at: null }
        state.approvals.push(approval)
        return { rows: [copy(approval)] }
      }
      if (sql.startsWith('SELECT id,status,expires_at<=clock_timestamp() AS expired FROM agent_approvals')) {
        return { rows: copy(state.approvals.filter(approval => approval.session_id === arg(values, 0)
          && approval.turn_id === arg(values, 1) && approval.tool_call_id === arg(values, 2))
          .slice(0, 1).map(approval => ({ id: approval.id, status: approval.status, expired: approval.expires_at.getTime() <= dbTime }))) }
      }
      if (sql.startsWith("UPDATE agent_approvals a SET status='expired'")) {
        assert.match(sql, /decision_revision=t\.revision/, 'the Turn revision is computed in SQL')
        assert.ok(!sql.includes('approval.required') && !sql.includes('agent_session_events') && !sql.includes('agent_budget_reservations'))
        const approval = state.approvals.find(row => row.id === arg(values, 0) && row.session_id === arg(values, 1)
          && row.turn_id === arg(values, 2) && row.status === 'pending' && row.expires_at.getTime() <= dbTime)
        if (!approval) return { rows: [] }
        approval.status = 'expired'; approval.resolved_at = at(); approval.decision_revision = state.turn.revision
        return { rows: [{ id: approval.id }] }
      }
      throw new Error(`unexpected fixture SQL: ${sql}`)
    },
  } as unknown as AgentCoreClient
  return { client, calls, get state() { return state }, setTime(value: number) { dbTime = value } }
}
type Fixture = ReturnType<typeof fixture>

/** Caller-owned transaction: this module must never control it, lock rows or supply a clock. */
function assertNoTransactionControl(f: Fixture) {
  assert.ok(f.calls.every(call => !/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(call.sql)))
  assert.ok(f.calls.every(call => !/FOR (UPDATE|SHARE)|NO KEY UPDATE/i.test(call.sql)))
  assert.ok(f.calls.every(call => !/now\(\)|transaction_timestamp\(\)/i.test(call.sql)))
  assert.ok(f.calls.every(call => call.args.every(value => !(value instanceof Date))))
  assert.ok(f.calls.every(call => call.args.every(value => typeof value !== 'number' || value < 1e12)))
}

test('agent-media-proposal: tool call insert allocates the next round position in the same statement', async () => {
  const f = fixture()
  const first = await appendAgentMediaProposalToolCall(f.client, toolInput)
  const second = await appendAgentMediaProposalToolCall(f.client, { ...toolInput, providerCallId: 'call-2', idempotencyKey: 'idem-2' })
  assert.deepEqual(first, { toolCallId: 'tool-0' })
  assert.deepEqual(second, { toolCallId: 'tool-1' })
  assert.deepEqual(f.state.tools.map(tool => [tool.id, tool.position, tool.status, tool.idempotency_key]),
    [['tool-0', 0, 'waiting_approval', 'idem-1'], ['tool-1', 1, 'waiting_approval', 'idem-2']])
  const inserts = f.calls.filter(call => call.sql.startsWith('INSERT INTO agent_tool_calls'))
  assert.equal(inserts.length, 2)
  for (const insert of inserts) {
    assert.match(insert.sql, /COALESCE\(\(SELECT MAX\(position\) FROM agent_tool_calls WHERE session_id=\$1 AND turn_id=\$2 AND round_id=\$3\),-1\)\+1/)
    assert.match(insert.sql, /RETURNING id$/)
  }
  assert.deepEqual(inserts[0]!.args, [sessionId, turnId, roundId, 'call-1', 'generate_image__v1', 2, JSON.stringify(args), argsHash, 'idem-1'])
  // No separate read-then-write position statement exists.
  assert.ok(f.calls.every(call => !/MAX\(position\)/.test(call.sql) || call.sql.startsWith('INSERT INTO agent_tool_calls')))
  assertNoTransactionControl(f)
})

test('agent-media-proposal: waiting_approval tool call emits the tool_call item and one tool.updated at the turn revision', async () => {
  const f = fixture()
  const { toolCallId: created } = await appendAgentMediaProposalToolCall(f.client, toolInput)
  assert.equal(f.state.items.length, 1)
  assert.deepEqual(f.state.items[0]!.payload,
    { providerCallId: 'call-1', toolName: 'generate_image__v1', toolSchemaVersion: 2, arguments: args })
  assert.equal(f.state.items[0]!.item_type, 'tool_call')
  assert.equal(f.state.items[0]!.tool_call_id, created)
  assert.deepEqual(f.state.events.map(e => [e.event_type, e.cursor, e.entity_revision, e.item_sequence]), [
    ['item.created', '1', '2', '1'],
    ['tool.updated', '2', '2', null],
  ])
  assert.deepEqual(f.state.events[1]!.payload,
    { tool: { id: created, turnId, toolName: 'generate_image__v1', status: 'waiting_approval', revision: '2' } })
  const order = ['SELECT id FROM agent_tool_calls', 'INSERT INTO agent_tool_calls', 'UPDATE agent_sessions SET next_item_sequence=',
    'INSERT INTO agent_items', 'UPDATE agent_sessions SET next_event_cursor=', 'INSERT INTO agent_session_events',
    'SELECT revision::text AS revision FROM agent_turns', 'UPDATE agent_sessions SET next_event_cursor=',
    'INSERT INTO agent_session_events']
  assert.equal(f.calls.length, order.length)
  order.forEach((prefix, index) => assert.ok(f.calls[index]!.sql.startsWith(prefix), `call ${index}: ${f.calls[index]!.sql}`))
  assertNoTransactionControl(f)
})

test('agent-media-proposal: tool call replay by (turn_id, idempotency_key) returns the stored id and writes nothing', async () => {
  const f = fixture()
  const first = await appendAgentMediaProposalToolCall(f.client, toolInput)
  const callsAfterFirst = f.calls.length, events = f.state.events.length, items = f.state.items.length
  const revoked = await appendAgentMediaProposalToolCall(f.client, { ...toolInput, providerCallId: 'call-other' })
  assert.deepEqual(revoked, first)
  assert.equal(f.calls.length, callsAfterFirst + 1)
  assert.match(f.calls.at(-1)!.sql, /^SELECT id FROM agent_tool_calls/)
  assert.ok(!f.calls.slice(callsAfterFirst).some(call => /INSERT|UPDATE/i.test(call.sql)))
  assert.equal(f.state.tools.length, 1); assert.equal(f.state.events.length, events); assert.equal(f.state.items.length, items)
  assertNoTransactionControl(f)
})

test('agent-media-proposal: approval insert derives expires_at from the turn deadline and the database clock', async () => {
  const f = fixture()
  const result = await createPendingAgentMediaApproval(f.client, approvalInput)
  assert.deepEqual(result, { approvalId })
  const insert = f.calls.find(call => call.sql.startsWith('INSERT INTO agent_approvals'))!
  assert.match(insert.sql, /'pending'/)
  assert.match(insert.sql, /LEAST\(t\.deadline_at,clock_timestamp\(\)\+interval '30 minutes'\)/)
  assert.match(insert.sql, /FROM agent_turns t WHERE t\.session_id=\$1 AND t\.id=\$2/)
  assert.doesNotMatch(insert.sql, /resolved_by|resolved_at/)
  assert.deepEqual(insert.args, [sessionId, turnId, toolCallId, argsHash, 'language-revision', 'price-v1', reservationId])
  assert.deepEqual(f.state.approvals.map(a => [a.status, a.resolved_by, a.resolved_at]), [['pending', null, null]])
  // The 10 minute turn deadline wins over the 30 minute window.
  assert.equal(f.state.approvals[0]!.expires_at.toISOString(), new Date(now + 10 * 60_000).toISOString())
  assertNoTransactionControl(f)
})

test('agent-media-proposal: approval insert caps a distant turn deadline at the 30 minute window', async () => {
  const f = fixture()
  f.state.turn.deadline_at = new Date(now + 60 * 60_000)
  await createPendingAgentMediaApproval(f.client, approvalInput)
  assert.equal(f.state.approvals[0]!.expires_at.toISOString(), new Date(now + 30 * 60_000).toISOString())
  assertNoTransactionControl(f)
})

test('agent-media-proposal: approval.required carries the full AgentApprovalSummaryDTO at the current turn revision', async () => {
  const f = fixture()
  await createPendingAgentMediaApproval(f.client, approvalInput)
  assert.deepEqual(f.state.events.map(e => [e.event_type, e.cursor, e.entity_revision]), [['approval.required', '1', '2']])
  assert.deepEqual(f.state.events[0]!.payload, { approval: {
    id: approvalId, sessionId, turnId, toolCallId, argumentsHash: argsHash, modelRevision: 'language-revision',
    pricingRevision: 'price-v1', reservationId, status: 'pending',
    expiresAt: new Date(now + 10 * 60_000).toISOString(), resolvedBy: null, resolvedAt: null, revision: '2',
  } })
  assert.ok(f.calls.some(call => call.sql.startsWith('SELECT revision::text AS revision FROM agent_turns')))
  assertNoTransactionControl(f)
})

test('agent-media-proposal: approval replay by (tool_call_id, arguments_hash) returns the stored id and emits nothing', async () => {
  const f = fixture()
  const first = await createPendingAgentMediaApproval(f.client, approvalInput)
  const callsAfterFirst = f.calls.length, events = f.state.events.length
  const replayed = await createPendingAgentMediaApproval(f.client, approvalInput)
  assert.deepEqual(replayed, first)
  assert.equal(f.calls.length, callsAfterFirst + 1)
  assert.match(f.calls.at(-1)!.sql, /^SELECT id FROM agent_approvals/)
  assert.ok(!f.calls.slice(callsAfterFirst).some(call => /INSERT|UPDATE/i.test(call.sql)))
  assert.equal(f.state.approvals.length, 1); assert.equal(f.state.events.length, events)
  assertNoTransactionControl(f)
})

test('agent-media-proposal: approval insert without a visible turn fails before any event', async () => {
  const f = fixture()
  f.state.turn.id = uuid(99)
  await assert.rejects(createPendingAgentMediaApproval(f.client, approvalInput), { message: 'AGENT_MEDIA_PROPOSAL_NOT_FOUND' })
  assert.equal(f.state.events.length, 0); assert.equal(f.state.approvals.length, 0)
  assertNoTransactionControl(f)
})

test('agent-media-proposal: read maps a pending expired approval to expired without writing it', async () => {
  const f = fixture()
  await createPendingAgentMediaApproval(f.client, approvalInput)
  const afterProposal = f.calls.length
  assert.deepEqual(await readAgentToolApproval(f.client, { scope, toolCallId }), { id: approvalId, status: 'pending', expired: false })
  f.setTime(now + 10 * 60_000)
  assert.deepEqual(await readAgentToolApproval(f.client, { scope, toolCallId }), { id: approvalId, status: 'expired', expired: true })
  assert.equal(f.state.approvals[0]!.status, 'pending')
  assert.equal(f.calls.length, afterProposal + 2)
  for (const call of f.calls.slice(afterProposal)) {
    assert.match(call.sql, /^SELECT id,status,expires_at<=clock_timestamp\(\) AS expired FROM agent_approvals/)
    assert.deepEqual(call.args, [sessionId, turnId, toolCallId])
  }
  assertNoTransactionControl(f)
})

for (const status of ['approved', 'rejected'] as const) {
  test(`agent-media-proposal: read reports a decided ${status} approval unchanged`, async () => {
    const f = fixture()
    f.state.approvals.push({ id: approvalId, session_id: sessionId, turn_id: turnId, tool_call_id: toolCallId,
      arguments_hash: argsHash, model_revision: 'language-revision', pricing_revision: 'price-v1',
      reservation_id: reservationId, status, expires_at: new Date(now - 1), resolved_by: ownerId, resolved_at: new Date(now) })
    assert.deepEqual(await readAgentToolApproval(f.client, { scope, toolCallId }), { id: approvalId, status, expired: true })
    assert.equal(f.state.approvals[0]!.status, status)
    assertNoTransactionControl(f)
  })
}

test('agent-media-proposal: read returns null for an unknown tool approval', async () => {
  const f = fixture()
  assert.equal(await readAgentToolApproval(f.client, { scope, toolCallId }), null)
  assert.deepEqual(f.calls[0]!.args, [sessionId, turnId, toolCallId])
  assertNoTransactionControl(f)
})

function approvalRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return { id: approvalId, session_id: sessionId, turn_id: turnId, tool_call_id: toolCallId, arguments_hash: argsHash,
    model_revision: 'language-revision', pricing_revision: 'price-v1', reservation_id: reservationId, status: 'pending',
    expires_at: new Date(now - 1), resolved_by: null, resolved_at: null, decision_revision: null, ...overrides }
}

test('agent-media-proposal: expire durably expires only a pending past-due approval at the Turn revision without an event', async () => {
  const f = fixture()
  f.state.turn.revision = '7'
  f.state.approvals.push(approvalRow())
  assert.equal(await expireAgentToolApproval(f.client, { scope, approvalId }), true)
  assert.equal(f.state.approvals[0]!.status, 'expired')
  assert.equal(f.state.approvals[0]!.resolved_at?.getTime(), now)
  assert.equal(f.state.approvals[0]!.decision_revision, '7')
  // Exactly one statement: no session event, no reservation write, no read of a client clock.
  assert.equal(f.calls.length, 1)
  assert.equal(f.state.events.length, 0)
  assert.match(f.calls[0]!.sql, /^UPDATE agent_approvals a SET status='expired',resolved_at=clock_timestamp\(\), decision_revision=t\.revision FROM agent_turns t/)
  assert.match(f.calls[0]!.sql, /t\.session_id=a\.session_id AND t\.id=a\.turn_id/)
  assert.match(f.calls[0]!.sql, /a\.id=\$1 AND a\.session_id=\$2 AND a\.turn_id=\$3/)
  assert.match(f.calls[0]!.sql, /a\.status='pending' AND a\.expires_at<=clock_timestamp\(\) RETURNING a\.id$/)
  assert.deepEqual(f.calls[0]!.args, [approvalId, sessionId, turnId])
  assertNoTransactionControl(f)
  // Idempotent replay: the same statement now matches no row and still emits nothing.
  assert.equal(await expireAgentToolApproval(f.client, { scope, approvalId }), false)
  assert.equal(f.calls.length, 2)
  assert.equal(f.state.events.length, 0)
  assert.equal(f.state.approvals[0]!.resolved_at?.getTime(), now)
  assert.equal(f.state.approvals[0]!.decision_revision, '7')
})

test('agent-media-proposal: expire ignores a live deadline, a decided approval and another Turn', async () => {
  const f = fixture()
  f.state.approvals.push(approvalRow({ expires_at: new Date(now + 1) }))
  f.state.approvals.push(approvalRow({ id: uuid(8), status: 'approved', expires_at: new Date(now - 1),
    resolved_by: ownerId, resolved_at: new Date(now), decision_revision: '2' }))
  f.state.approvals.push(approvalRow({ id: uuid(9), turn_id: uuid(10) }))
  assert.equal(await expireAgentToolApproval(f.client, { scope, approvalId }), false)
  assert.equal(await expireAgentToolApproval(f.client, { scope, approvalId: uuid(8) }), false)
  assert.equal(await expireAgentToolApproval(f.client, { scope, approvalId: uuid(9) }), false)
  assert.deepEqual(f.state.approvals.map(row => [row.status, row.resolved_at?.getTime() ?? null, row.decision_revision]),
    [['pending', null, null], ['approved', now, '2'], ['pending', null, null]])
  assert.equal(f.state.events.length, 0)
  assertNoTransactionControl(f)
})
