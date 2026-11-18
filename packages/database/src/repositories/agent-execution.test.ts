import assert from 'node:assert/strict'
import test from 'node:test'
import type { JsonObject } from '@musecanvas/contracts'
import type { AgentCoreClient } from './agent-core'
import { createAgentExecutionRepository, projectAgentFinalToolResult, queueAgentTurnIfDependenciesTerminal } from './agent-execution'
import { AgentRuntimeRepository } from './agent-runtime'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ownerId = uuid(1), sessionId = uuid(2), turnId = uuid(3), roundId = uuid(4)
const rawToolId = uuid(10), proposalToolId = uuid(11), foreignTurnId = uuid(12)
const now = Date.parse('2026-11-17T08:00:00Z')
const result: JsonObject = { content: 'Media generation completed: job-1',
  jobs: [{ jobId: 'job-1', status: 'succeeded', assetIds: ['a1'] }] }

interface ToolRow {
  id: string; session_id: string; turn_id: string; round_id: string; position: number; provider_call_id: string
  tool_name: string; tool_schema_version: number; arguments: Record<string, unknown>; arguments_hash: string
  status: string; idempotency_key: string; result: Record<string, unknown> | null; error: Record<string, unknown> | null
}
interface ItemRow { id: string; session_id: string; turn_id: string; sequence: string; item_type: string
  tool_call_id: string | null; payload: Record<string, unknown>; created_at: Date }
interface EventRow { session_id: string; turn_id: string; cursor: string; event_type: string; payload: Record<string, unknown> }
interface TurnRow {
  id: string; session_id: string; status: string; engine_version: string; revision: string; input_revision: string
  fencing_token: string; lease_owner: string | null; lease_until: Date | null; cancel_requested_at: Date | null
  terminal_at: Date | null; deadline_at: Date; error: Record<string, unknown> | null
}
interface SessionRow { id: string; owner_id: string; active_turn_id: string | null; archived_at: Date | null
  next_item_sequence: string; next_event_cursor: string }
interface OutboxRow { event_type: string; aggregate_id: string; payload: Record<string, unknown>; dedupe_key: string }

function tool(overrides: Partial<ToolRow> & Pick<ToolRow, 'id' | 'position' | 'provider_call_id' | 'idempotency_key'>): ToolRow {
  return { session_id: sessionId, turn_id: turnId, round_id: roundId, tool_name: 'generate_image', tool_schema_version: 1,
    arguments: {}, arguments_hash: 'a'.repeat(64), status: 'waiting_external', result: null, error: null, ...overrides }
}
function initial(): { actor: { id: string; active: boolean }; session: SessionRow; turn: TurnRow
  tools: ToolRow[]; items: ItemRow[]; events: EventRow[]; approvals: { status: string }[]
  reservations: { status: string; quota?: string; reserved_amount?: string }[]; rounds: { status: string }[]; outbox: OutboxRow[] } {
  return {
    actor: { id: ownerId, active: true },
    session: { id: sessionId, owner_id: ownerId, active_turn_id: turnId, archived_at: null,
      next_item_sequence: '1', next_event_cursor: '1' },
    turn: { id: turnId, session_id: sessionId, status: 'waiting_tools', engine_version: 'agent-core-v1', revision: '4',
      input_revision: '1', fencing_token: '0', lease_owner: null, lease_until: null, cancel_requested_at: null,
      terminal_at: null, deadline_at: new Date(now + 10_000), error: null },
    tools: [tool({ id: rawToolId, position: 0, provider_call_id: 'call-raw-1', idempotency_key: 'round:0:0:call-raw-1' }),
      tool({ id: proposalToolId, position: 1, provider_call_id: `agent-proposal:${rawToolId}`, idempotency_key: `proposal:${rawToolId}` })],
    items: [], events: [], approvals: [], reservations: [], rounds: [], outbox: [],
  }
}

// Deliberately limited in-memory SQL model: it verifies statement shape, bound
// parameters, ordering and replay behaviour, including the agent_guard_tool_update
// finality rule. It is NOT PostgreSQL isolation or concurrency validation.
function fixture(seed = initial()) {
  const state = seed
  const calls: { sql: string; args: unknown[] }[] = []
  const arg = (values: unknown[], index: number) => String(values[index])
  const sameRow = (row: ToolRow, values: unknown[]) => row.id === arg(values, 2)
    && row.session_id === arg(values, 0) && row.turn_id === arg(values, 1)
  const final = (status: string) => ['completed', 'failed', 'cancelled', 'skipped'].includes(status)
  const client = {
    async query(raw: string, values: unknown[] = []) {
      const sql = raw.replace(/\s+/g, ' ').trim()
      calls.push({ sql, args: values })
      const binds = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]))
      assert.equal(binds.length ? Math.max(...binds) : 0, values.length)
      if (sql.startsWith('SELECT s.owner_id FROM agent_sessions s JOIN agent_turns t')) {
        return { rows: state.session.id === arg(values, 0) && state.turn.id === arg(values, 1) ? [{ owner_id: ownerId }] : [] }
      }
      if (sql.startsWith('SELECT id FROM users')) return { rows: values[0] === ownerId ? [{ id: ownerId }] : [] }
      if (sql.startsWith('SELECT id FROM agent_sessions')) return { rows: [{ id: sessionId }] }
      if (sql.startsWith('SELECT id FROM agent_turns')) return { rows: [{ id: turnId }] }
      if (sql.startsWith('SELECT * FROM agent_tool_calls')) {
        return { rows: state.tools.filter(row => row.id === arg(values, 2) && row.session_id === arg(values, 0)
          && row.turn_id === arg(values, 1)).map(row => structuredClone(row)) }
      }
      // The cross-module case drives the real runtime leases and task predicates.
      const leaseLive = () => state.turn.lease_until !== null && state.turn.lease_until.getTime() > now
      const executable = () => state.turn.cancel_requested_at === null && state.turn.deadline_at.getTime() > now
      if (sql.startsWith("SELECT id,(status='active' AND deleted_at IS NULL) AS active FROM users")) {
        return { rows: state.actor.id === values[0] ? [structuredClone(state.actor)] : [] }
      }
      if (sql.startsWith('SELECT id,owner_id,active_turn_id,archived_at FROM agent_sessions')) {
        return { rows: state.session.owner_id === values[0] && state.session.id === values[1] ? [structuredClone(state.session)] : [] }
      }
      if (sql.startsWith('SELECT * FROM agent_turns WHERE session_id=$1 AND id=$2')) {
        return { rows: state.turn.session_id === values[0] && state.turn.id === values[1] ? [structuredClone(state.turn)] : [] }
      }
      if (sql.startsWith('SELECT t.* FROM agent_turns t')) {
        const t = state.turn
        return { rows: state.session.owner_id === values[0] && state.session.id === values[1] && t.id === values[2]
          && state.session.active_turn_id === t.id && state.session.archived_at === null && state.actor.active
          && t.status === 'running' && t.lease_owner === values[3] && t.fencing_token === values[4]
          && leaseLive() && executable() && t.input_revision === values[5] ? [structuredClone(t)] : [] }
      }
      if (sql.startsWith('SELECT x.id,x.status,')) {
        return { rows: state.tools.filter(row => row.turn_id === values[0] && row.session_id === values[1])
          .map(row => ({ id: row.id, status: row.status,
            has_result: state.items.some(item => item.tool_call_id === row.id && item.item_type === 'tool_result') })) }
      }
      if (sql.startsWith('SELECT status FROM agent_approvals')) return { rows: structuredClone(state.approvals) }
      if (sql.startsWith('SELECT status FROM agent_budget_reservations')) return { rows: structuredClone(state.reservations) }
      if (sql.startsWith('SELECT status FROM agent_model_rounds')) return { rows: structuredClone(state.rounds) }
      if (sql.startsWith("UPDATE agent_turns t SET status='queued'")) {
        const t = state.turn, tools = state.tools.filter(row => row.turn_id === t.id)
        const unpaired = tools.some(row => !final(row.status)
          || !state.items.some(item => item.tool_call_id === row.id && item.item_type === 'tool_result'))
        if (t.id !== arg(values, 2) || t.session_id !== arg(values, 1) || state.session.owner_id !== arg(values, 0)
          || state.session.active_turn_id !== t.id || !['waiting_tools', 'waiting_approval'].includes(t.status)
          || t.cancel_requested_at !== null || t.deadline_at.getTime() <= now || !tools.length || unpaired
          || state.approvals.some(row => row.status === 'pending')
          || state.reservations.some(row => row.status === 'reserved' || row.status === 'unknown')) return { rows: [] }
        t.status = 'queued'; t.revision = String(BigInt(t.revision) + 1n)
        return { rows: [structuredClone(t)] }
      }
      if (sql.startsWith('UPDATE agent_turns SET lease_owner=$3')) {
        const t = state.turn
        if (t.id !== arg(values, 1) || t.session_id !== arg(values, 0)
          || !['queued', 'running', 'waiting_tools', 'waiting_approval'].includes(t.status)
          || (t.lease_until !== null && t.lease_until.getTime() > now) || !executable()) return { rows: [] }
        t.lease_owner = arg(values, 2)
        t.lease_until = new Date(Math.min(t.deadline_at.getTime(), now + Number(values[3])))
        t.fencing_token = String(BigInt(t.fencing_token) + 1n)
        if (t.status !== 'running') t.revision = String(BigInt(t.revision) + 1n)
        t.status = 'running'
        return { rows: [structuredClone(t)] }
      }
      if (sql.startsWith('UPDATE agent_turns SET status=$6')) {
        const t = state.turn
        if (t.id !== arg(values, 1) || t.session_id !== arg(values, 0) || t.status !== 'running'
          || t.lease_owner !== values[2] || t.fencing_token !== values[3] || !leaseLive() || !executable()
          || t.input_revision !== values[4]) return { rows: [] }
        t.status = arg(values, 5); t.error = values[6] == null ? null : JSON.parse(String(values[6]))
        t.terminal_at = values[7] ? new Date(now) : null; t.lease_owner = null; t.lease_until = null
        t.revision = String(BigInt(t.revision) + 1n)
        return { rows: [structuredClone(t)] }
      }
      if (sql.startsWith('UPDATE agent_sessions SET active_turn_id=NULL')) {
        if (state.session.id !== values[0] || state.session.owner_id !== values[1]
          || state.session.active_turn_id !== values[2]) return { rows: [], rowCount: 0 }
        state.session.active_turn_id = null
        return { rows: [], rowCount: 1 }
      }
      if (sql.startsWith('INSERT INTO outbox_events')) {
        state.outbox.push({ event_type: 'agent.turn.wake', aggregate_id: arg(values, 0),
          payload: JSON.parse(String(values[1])), dedupe_key: arg(values, 2) })
        return { rows: [] }
      }
      if (sql.startsWith('SELECT id,status,tool_name FROM agent_tool_calls')) {
        return { rows: state.tools.filter(row => row.id === arg(values, 2) && row.session_id === arg(values, 0)
          && row.turn_id === arg(values, 1)).map(row => ({ id: row.id, status: row.status, tool_name: row.tool_name })) }
      }
      if (sql.startsWith('UPDATE agent_tool_calls')) {
        const row = state.tools.find(candidate => sameRow(candidate, values))!
        const next = { status: arg(values, 3), result: values[4] == null ? null : JSON.parse(String(values[4])),
          error: values[5] == null ? null : JSON.parse(String(values[5])) }
        if (final(row.status) && (row.status !== next.status || row.result !== next.result || row.error !== next.error)) {
          throw new Error('agent tool result already final')
        }
        Object.assign(row, next)
        return { rows: [] }
      }
      if (sql.startsWith('SELECT l.media_job_id,j.status')) return { rows: [] }
      if (sql.startsWith('WITH settled AS')) return { rows: [] }
      if (sql.startsWith('SELECT id FROM agent_items')) {
        return { rows: state.items.filter(item => item.tool_call_id === String(values[0]) && item.item_type === 'tool_result')
          .map(item => ({ id: item.id })) }
      }
      if (sql.startsWith('SELECT revision::text FROM agent_turns')) {
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
          payload: JSON.parse(String(values[5])), created_at: new Date(now) }
        state.items.push(item)
        return { rows: [structuredClone(item)] }
      }
      if (sql.startsWith('UPDATE agent_sessions SET next_event_cursor=')) {
        const cursor = state.session.next_event_cursor
        state.session.next_event_cursor = String(BigInt(cursor) + 1n)
        return { rows: [{ cursor }] }
      }
      if (sql.startsWith('INSERT INTO agent_session_events')) {
        const literal = sql.includes("'turn.updated'")
        state.events.push({ session_id: arg(values, 0), turn_id: arg(values, 1), cursor: arg(values, 2),
          event_type: literal ? 'turn.updated' : arg(values, 4),
          payload: JSON.parse(String(values[literal ? 4 : 5])) })
        return { rows: [] }
      }
      throw new Error(`unexpected fixture SQL: ${sql}`)
    },
  } as unknown as AgentCoreClient
  return { client, calls, state }
}
type Fixture = ReturnType<typeof fixture>

const record = (f: Fixture, toolCallId: string, status: 'completed' | 'failed' | 'cancelled' = 'completed',
  payload: JsonObject | null = result) => createAgentExecutionRepository().recordToolResult(f.client, {
    toolCallId, sessionId, turnId, idempotencyKey: `media-result:${toolCallId}`, status,
    result: payload, error: status === 'completed' ? null : { code: 'TOOL_FAILED', message: 'Media generation failed', retryable: false } })
const paired = (f: Fixture, toolCallId: string) => f.state.items.filter(item => item.tool_call_id === toolCallId
  && item.item_type === 'tool_result')

/** Caller-owned transaction: this module must never control it. */
function assertNoTransactionControl(f: Fixture) {
  assert.ok(f.calls.every(call => !/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(call.sql)))
}

test('agent-execution: a canonical proposal result is mirrored onto the raw model-visible call', async () => {
  const f = fixture()
  assert.deepEqual(await record(f, proposalToolId), { recorded: true, finalResult: true })
  const [raw, canonical] = f.state.tools
  assert.equal(canonical!.status, 'completed')
  assert.deepEqual(canonical!.result, result)
  assert.equal(raw!.status, 'completed')
  assert.deepEqual(raw!.result, result)
  assert.deepEqual(raw!.error, null)
  // Exactly one result item per row, with the same payload.
  for (const id of [rawToolId, proposalToolId]) {
    const items = paired(f, id)
    assert.equal(items.length, 1, `one result item for ${id}`)
    assert.deepEqual(items[0]!.payload.result, result)
    assert.equal(items[0]!.payload.status, 'completed')
  }
  assert.deepEqual(f.state.events.filter(event => event.event_type === 'tool.updated').map(event => event.payload.tool as { id: string; turnId: string; toolName: string; status: string; revision: string }),
    [{ id: proposalToolId, turnId, toolName: 'generate_image', status: 'completed', revision: '4' },
      { id: rawToolId, turnId, toolName: 'generate_image', status: 'completed', revision: '4' }])
  // The mirror runs after the canonical settlement and canonical projection.
  const settleAt = f.calls.findIndex(call => call.sql.startsWith('WITH settled AS') || call.sql.startsWith('SELECT l.media_job_id,j.status'))
  const canonicalItemAt = f.calls.findIndex(call => call.sql.startsWith('INSERT INTO agent_items')
    && call.args[4] === proposalToolId)
  const mirrorAt = f.calls.findIndex(call => call.sql.startsWith('SELECT id,status,tool_name FROM agent_tool_calls'))
  assert.ok(settleAt >= 0 && canonicalItemAt > settleAt && mirrorAt > canonicalItemAt,
    `settle ${settleAt} < canonical item ${canonicalItemAt} < mirror ${mirrorAt}`)
  assertNoTransactionControl(f)
})

test('agent-execution: the shared final projection mirrors for the recovery sweep too', async () => {
  const f = fixture()
  // The recovery sweep finalizes the canonical row it selected and projects that row.
  await f.client.query(`UPDATE agent_tool_calls SET status='completed',result=$4::jsonb WHERE id=$3 AND session_id=$1 AND turn_id=$2`,
    [sessionId, turnId, proposalToolId, JSON.stringify(result)])
  const canonical = f.state.tools[1]!
  const record = await projectAgentFinalToolResult(f.client, { ownerId, sessionId, turnId },
    { id: canonical.id, tool_name: canonical.tool_name, status: 'completed', result, error: null,
      provider_call_id: canonical.provider_call_id }, '4')
  assert.deepEqual(record, { recorded: true, finalResult: true })
  assert.deepEqual([f.state.tools[0]!.status, f.state.tools[0]!.result], ['completed', result])
  assert.equal(paired(f, rawToolId).length, 1)
  assert.equal(paired(f, proposalToolId).length, 1)
})

test('agent-execution: a replayed proposal result writes no second item, event or tool row', async () => {
  const f = fixture()
  await record(f, proposalToolId)
  const callsAfterFirst = f.calls.length, items = f.state.items.length, events = f.state.events.length
  assert.deepEqual(await record(f, proposalToolId), { recorded: false, finalResult: true })
  const replayed = f.calls.slice(callsAfterFirst)
  assert.ok(replayed.every(call => !/^(INSERT|UPDATE|WITH)/.test(call.sql)), 'replay only reads')
  assert.equal(f.state.items.length, items)
  assert.equal(f.state.events.length, events)
  assert.deepEqual(f.state.tools.map(row => row.status), ['completed', 'completed'])
})

test('agent-execution: a failed proposal result mirrors its error instead of inventing success', async () => {
  const f = fixture()
  const payload = { content: 'Media generation failed.', jobs: [{ jobId: 'job-1', status: 'failed', assetIds: [] }] }
  await record(f, proposalToolId, 'failed', payload)
  const [raw, canonical] = f.state.tools
  assert.equal(canonical!.status, 'failed')
  assert.equal(raw!.status, 'failed')
  assert.deepEqual(raw!.result, payload)
  assert.deepEqual(raw!.error, { code: 'TOOL_FAILED', message: 'Media generation failed', retryable: false })
  assert.deepEqual(paired(f, rawToolId)[0]!.payload.error, raw!.error)
})

test('agent-execution: a tool row without the proposal prefix is never mirrored', async () => {
  const f = fixture()
  await record(f, rawToolId)
  assert.deepEqual(f.state.tools.map(row => row.status), ['completed', 'waiting_external'])
  assert.equal(paired(f, rawToolId).length, 1)
  assert.equal(paired(f, proposalToolId).length, 0)
  assert.deepEqual(f.state.events.filter(event => event.event_type === 'tool.updated').map(event => (event.payload.tool as { id: string }).id),
    [rawToolId])
})

test('agent-execution: a raw row that is already final and paired is left untouched', async () => {
  const seed = initial()
  seed.tools[0] = { ...seed.tools[0]!, status: 'failed', result: { reason: 'APPROVAL_REQUIRED', proposalRequired: true,
    proposalToolCallId: proposalToolId }, error: { code: 'TOOL_FAILED', message: 'APPROVAL_REQUIRED', retryable: false } }
  seed.items.push({ id: 'item-0', session_id: sessionId, turn_id: turnId, sequence: '1', item_type: 'tool_result',
    tool_call_id: rawToolId, payload: { status: 'failed', result: seed.tools[0]!.result }, created_at: new Date(now) })
  seed.session.next_item_sequence = '2'
  const f = fixture(seed)
  await record(f, proposalToolId)
  assert.deepEqual(f.state.tools[0]!.result, { reason: 'APPROVAL_REQUIRED', proposalRequired: true,
    proposalToolCallId: proposalToolId })
  assert.equal(paired(f, rawToolId).length, 1)
  assert.ok(f.calls.every(call => !(call.sql.startsWith('UPDATE agent_tool_calls') && call.args[2] === rawToolId)))
  assert.deepEqual(f.state.events.filter(event => event.event_type === 'tool.updated').map(event => (event.payload.tool as { id: string }).id),
    [proposalToolId])
})

test('agent-execution: a proposal whose raw call is missing is recorded but not mirrored', async () => {
  const seed = initial()
  seed.tools[1] = { ...seed.tools[1]!, provider_call_id: `agent-proposal:${uuid(20)}` }
  const f = fixture(seed)
  await record(f, proposalToolId)
  assert.deepEqual(f.state.tools.map(row => row.status), ['waiting_external', 'completed'])
  assert.equal(f.state.items.length, 1)
  assert.equal(f.state.events.filter(event => event.event_type === 'tool.updated').length, 1)
})

test('agent-execution: a proposal never mirrors onto a raw call of another turn', async () => {
  const seed = initial()
  seed.tools[0] = { ...seed.tools[0]!, turn_id: foreignTurnId }
  seed.tools[1] = { ...seed.tools[1]!, provider_call_id: `agent-proposal:${rawToolId}` }
  const f = fixture(seed)
  await record(f, proposalToolId)
  assert.deepEqual(f.state.tools.map(row => [row.status, row.result]), [['waiting_external', null], ['completed', result]])
  assert.equal(f.state.items.length, 1)
})

test('agent-execution: an empty prefix remainder is not a mirror target', async () => {
  const seed = initial()
  seed.tools[1] = { ...seed.tools[1]!, provider_call_id: 'agent-proposal:' }
  const f = fixture(seed)
  await record(f, proposalToolId)
  assert.deepEqual(f.state.tools.map(row => row.status), ['waiting_external', 'completed'])
  assert.ok(f.calls.every(call => !call.sql.startsWith('SELECT id,status,tool_name FROM agent_tool_calls')))
  assert.equal(f.state.items.length, 1)
})

test('agent-execution: a settled zero-priced estimated_cost reservation blocks neither the wake nor the completed transition', async () => {
  const seed = initial()
  seed.tools = [tool({ id: rawToolId, position: 0, provider_call_id: 'call-raw-1', idempotency_key: 'round:0:0:call-raw-1',
    status: 'failed', error: { code: 'TOOL_FAILED', message: 'Media outcome was not observed before the turn ended', retryable: false } })]
  seed.items.push({ id: 'item-0', session_id: sessionId, turn_id: turnId, sequence: '1', item_type: 'tool_result',
    tool_call_id: rawToolId, payload: { status: 'failed' }, created_at: new Date(now) })
  seed.session.next_item_sequence = '2'
  // The media proposal settled its zero-priced estimated_cost reservation; only
  // the settled row remains, so neither guard may treat it as live budget.
  seed.reservations.push({ status: 'settled', quota: 'estimated_cost', reserved_amount: '0' })
  const f = fixture(seed)
  assert.deepEqual(await queueAgentTurnIfDependenciesTerminal(f.client, { ownerId, sessionId, turnId }),
    { sessionId, turnId, revision: '5' })
  assert.equal(f.state.turn.status, 'queued')
  assert.deepEqual(f.state.outbox, [{ event_type: 'agent.turn.wake', aggregate_id: turnId,
    payload: { schemaVersion: 1, sessionId, turnId, revision: '5' }, dedupe_key: `agent:${turnId}:5` }])
  // The emitted wake is claimable, and the terminal invariant accepts completion
  // with the settled zero amount still visible in the reservation table.
  const runtime = new AgentRuntimeRepository(async work => work(f.client))
  const lease = await runtime.claimTurnLease({ ownerId, sessionId, turnId, leaseOwner: 'worker-a', leaseDurationMs: 5000 })
  assert.ok(lease, 'the wake is claimable')
  const done = await runtime.transitionWithTurnLease({ ownerId, sessionId, turnId, leaseOwner: 'worker-a',
    fencingToken: lease!.fencingToken, expectedInputRevision: lease!.inputRevision }, { to: 'completed' }, async () => undefined)
  assert.equal(done.turn.status, 'completed')
  assert.equal(f.state.turn.status, 'completed')
  assert.equal(f.state.turn.revision, '7')
  assert.equal(f.state.session.active_turn_id, null)
})
