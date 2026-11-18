import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { AgentCoreError, AgentCoreRepository, agentCoreDecimal, agentTurnDTO, type AgentCoreClient, type AgentCoreTransaction, type AgentDefinitionValidator } from './agent-core'
import { canvasAgentRequestDigest } from './canvas-agent'

const owner = '10000000-0000-4000-8000-000000000001'
const sid = '20000000-0000-4000-8000-000000000001'
const tid = '30000000-0000-4000-8000-000000000001'
const mid = '40000000-0000-4000-8000-000000000001'
const now = new Date('2026-11-17T08:00:00Z')
const s = { id: sid, owner_id: owner, agent_definition_id: mid, definition_version: 1, default_canvas_id: null, active_turn_id: tid,
  input_revision: '1', next_item_sequence: '2', next_event_cursor: '3', event_retention_floor: '0', created_at: now, updated_at: now, archived_at: null }
const t = { id: tid, session_id: sid, status: 'queued', engine_version: 'agent-core-v1', revision: '1', input_revision: '1',
  cancel_requested_at: null, terminal_at: null, deadline_at: new Date(now.getTime() + 30000), error: null, lease_owner: null,
  config_snapshot: { modelRevisionId: mid }, budget_snapshot: {} }
const accepted = { turn: agentTurnDTO(t), acceptedInputRevision: '1' }
type Step = [RegExp, Record<string, unknown>[]]
function fixture(steps: Step[], validator?: AgentDefinitionValidator) {
  const calls: { sql: string; args: unknown[] }[] = [], modes: boolean[] = []
  let validations = 0
  const client = { async query(sql: string, args: unknown[] = []) {
    calls.push({ sql, args })
    const step = steps.shift(); assert.ok(step, `unexpected SQL: ${sql}`)
    assert.match(sql.replace(/\s+/g, ' '), step[0])
    const parameters = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]))
    assert.equal(parameters.length ? Math.max(...parameters) : 0, args.length, 'bind count (not a PG syntax proof)')
    return { rows: step[1] }
  } } as unknown as AgentCoreClient
  const tx: AgentCoreTransaction = async (work, readOnly = false) => { modes.push(readOnly); return work(client) }
  const repo = new AgentCoreRepository(tx, async (c, d) => {
    validations++
    if (validator) return validator(c, d)
    return { config: { modelRevisionId: mid }, budget: { maxModelCalls: 2, maxToolCalls: 4, maxMediaJobs: 0, maxMediaOutputs: 0,
      maxInputTokens: '10', maxOutputTokens: '20', maxEstimatedCost: null, maxConcurrentMediaJobs: 0 }, timeoutMs: 30000 }
  })
  return { repo, calls, modes, done() { assert.equal(steps.length, 0) }, get validations() { return validations } }
}
const actor: Step = [/FROM users .* FOR NO KEY UPDATE/, [{ id: owner }]]
const lockedSession: Step = [/FROM agent_sessions WHERE owner_id=\$1 AND id=\$2 FOR UPDATE/, [s]]
const lookupTurn: Step = [/FROM agent_turns t JOIN agent_sessions s .*s.owner_id=\$1 AND t.id=\$2$/, [t]]
const lockedTurn: Step = [/FROM agent_turns t JOIN agent_sessions s .*FOR UPDATE OF t/, [t]]
function eventSteps(cursor: string): Step[] { return [[/UPDATE agent_sessions SET next_event_cursor=next_event_cursor\+1/, [{ cursor }]], [/INSERT INTO agent_session_events/, []]] }
const wakeStep: Step = [/INSERT INTO outbox_events.*agent.turn.wake/, []]

test('agent-core: session receipt checked before mutable definition/admission; owner-global changed-body conflict', async () => {
  const input = { clientRequestId: 'create-1', agentDefinitionId: mid, definitionVersion: 1 }
  const digest = canvasAgentRequestDigest({ agentDefinitionId: mid, definitionVersion: 1, defaultCanvasId: null })
  const f = fixture([actor, [/FROM agent_session_requests WHERE owner_id=\$1 AND client_request_key=\$2/, [{ request_digest: digest, accepted_response: { id: sid } }]]])
  assert.deepEqual(await f.repo.createSession(owner, input, false), { id: sid })
  assert.equal(f.validations, 0); f.done()
  const conflict = fixture([actor, [/FROM agent_session_requests/, [{ request_digest: digest, accepted_response: {} }]]])
  await assert.rejects(conflict.repo.createSession(owner, { ...input, definitionVersion: 2 }, false), { code: 'CONFLICT' }); conflict.done()
})

test('agent-core: new session validates active owner/system definition and canvas under actor serialization', async () => {
  const f = fixture([actor, [/FROM agent_session_requests/, []], [/FROM agent_definitions .*status='active'.*owner_id IS NULL OR owner_id=\$3.*FOR SHARE/, [{ id: mid }]],
    [/FROM canvas_documents .*created_by=\$2 AND deleted_at IS NULL FOR SHARE/, [{ id: tid }]], [/INSERT INTO agent_sessions/, [s]], [/INSERT INTO agent_session_requests/, []]])
  const result = await f.repo.createSession(owner, { clientRequestId: 'c', agentDefinitionId: mid, definitionVersion: 1, defaultCanvasId: tid })
  assert.equal(result.id, sid); assert.equal(f.validations, 1); f.done()
})

test('agent-core: message replay survives cancellation/terminal/config changes and emits no second item/revision/wake', async () => {
  const input = { clientMessageId: mid, content: 'hello' }
  const digest = canvasAgentRequestDigest({ sessionId: sid, content: 'hello' })
  const f = fixture([actor, lockedSession, [/FROM agent_message_receipts WHERE session_id=\$1 AND client_message_id=\$2/, [{ request_digest: digest, turn_id: tid, accepted_response: accepted }]]])
  assert.deepEqual(await f.repo.message(owner, sid, input, false, tid), accepted)
  assert.equal(f.validations, 0); assert.equal(f.calls.length, 3); f.done()
  const conflict = fixture([actor, lockedSession, [/FROM agent_message_receipts/, [{ request_digest: digest, turn_id: tid, accepted_response: accepted }]]])
  await assert.rejects(conflict.repo.message(owner, sid, { ...input, content: 'changed' }), { code: 'CONFLICT' }); conflict.done()
})

test('agent-core: queued admission persists item/events/receipt/wake in one transaction and derives deadline from DB clock', async () => {
  const f = fixture([actor, [/FROM agent_sessions.*FOR UPDATE/, [{ ...s, active_turn_id: null }]], [/FROM agent_message_receipts/, []],
    [/FROM agent_definitions/, [{ id: mid }]], [/UPDATE agent_sessions SET input_revision=input_revision\+1/, [{ input_revision: '1', sequence: '1' }]],
    [/WITH deadline AS \(SELECT clock_timestamp\(\)\+\$6\*interval '1 millisecond'.*INSERT INTO agent_turns/, [t]],
    [/UPDATE agent_sessions SET active_turn_id/, []], [/INSERT INTO agent_items/, [{ id: mid, session_id: sid, turn_id: tid, sequence: '1', item_type: 'user_message', tool_call_id: null, payload: { content: 'hello', secret: 'hidden' }, created_at: now }]],
    ...eventSteps('1'), ...eventSteps('2'), wakeStep, [/INSERT INTO agent_message_receipts/, []]])
  assert.deepEqual(await f.repo.message(owner, sid, { clientMessageId: mid, content: 'hello' }), accepted)
  assert.deepEqual(f.modes, [false]); assert.equal(f.validations, 1)
  const insert = f.calls.find(c => /INSERT INTO agent_turns/.test(c.sql))!
  assert.equal(insert.args[5], 30000)
  assert.equal('deadlineAt' in JSON.parse(String(insert.args[4])), false)
  assert.equal(f.calls.find(c => /INSERT INTO agent_session_events/.test(c.sql))!.args[6]!.toString().includes('hidden'), false)
  f.done()
})

test('agent-core: steering keeps running status/lease while advancing durable input revision and receipt even when admission closed', async () => {
  const running = { ...t, status: 'running', lease_owner: 'runner' }
  const updated = { ...running, revision: '2', input_revision: '2' }
  const f = fixture([actor, lockedSession, [/FROM agent_message_receipts/, []], [/FROM agent_turns .*FOR UPDATE OF t/, [running]],
    [/UPDATE agent_sessions SET input_revision=input_revision\+1/, [{ input_revision: '2', sequence: '2' }]],
    [/UPDATE agent_turns SET input_revision=\$3,revision=revision\+1/, [updated]],
    [/INSERT INTO agent_items/, [{ id: mid, session_id: sid, turn_id: tid, sequence: '2', item_type: 'user_message', tool_call_id: null, payload: { content: 'steer' }, created_at: now }]],
    ...eventSteps('3'), ...eventSteps('4'), wakeStep, [/INSERT INTO agent_message_receipts/, []]])
  assert.equal((await f.repo.message(owner, sid, { clientMessageId: mid, content: 'steer' }, false)).acceptedInputRevision, '2')
  const sql = f.calls.filter(c => /UPDATE agent_turns/.test(c.sql)).map(c => c.sql).join('')
  assert.doesNotMatch(sql, /lease_owner=|status=/); assert.equal(f.validations, 0); f.done()
})

test('agent-core: cancel lock order Session->Turn->Tool; running leaves lease/status intact and persists one control wake', async () => {
  const running = { ...t, status: 'running', lease_owner: 'runner' }
  const f = fixture([actor, [/FROM agent_turns .*t.id=\$2$/, [running]], lockedSession, [/FOR UPDATE OF t/, [running]],
    [/FROM agent_tool_calls .*ORDER BY id FOR UPDATE/, [{ id: mid, status: 'executing' }]],
    [/FROM agent_approvals .*ORDER BY id FOR UPDATE/, []], [/FROM agent_budget_reservations .*ORDER BY id FOR UPDATE/, []],
    [/UPDATE agent_turns SET cancel_requested_at=clock_timestamp\(\),revision=revision\+1/, [{ ...running, revision: '2', cancel_requested_at: now }]], ...eventSteps('3'), wakeStep])
  const result = await f.repo.cancel(owner, tid)
  assert.equal(result.status, 'running')
  assert.equal(f.calls.find(c => /UPDATE agent_turns/.test(c.sql))!.args[2], false)
  assert.doesNotMatch(f.calls.map(c => c.sql).join(''), /SET lease_|generation_jobs|tool_result/); f.done()
})

test('agent-core: queued cancel clears active locally only after all tool/approval/reservation dependencies are terminal', async () => {
  const f = fixture([actor, lookupTurn, lockedSession, lockedTurn, [/FROM agent_tool_calls .*FOR UPDATE/, []],
    [/FROM agent_approvals .*FOR UPDATE/, []], [/FROM agent_budget_reservations .*FOR UPDATE/, []],
    [/UPDATE agent_turns/, [{ ...t, status: 'cancelled', terminal_at: now, cancel_requested_at: now, revision: '2' }]],
    [/UPDATE agent_sessions SET active_turn_id=NULL/, []], ...eventSteps('3')])
  assert.equal((await f.repo.cancel(owner, tid)).status, 'cancelled'); f.done()
  const finished = { ...t, status: 'completed', terminal_at: now }
  const duplicate = fixture([actor, [/FROM agent_turns/, [finished]], lockedSession, [/FOR UPDATE OF t/, [finished]]])
  assert.equal((await duplicate.repo.cancel(owner, tid)).status, 'completed'); duplicate.done()
})

test('agent-core: cancel preserves waiting approval/tools and retained reservation dependencies for Runner', async () => {
  for (const { status, toolStatus, approvalStatus, reservationStatus } of [
    { status: 'waiting_approval', toolStatus: 'waiting_approval', approvalStatus: 'pending', reservationStatus: 'reserved' },
    { status: 'waiting_tools', toolStatus: 'recorded', approvalStatus: undefined, reservationStatus: 'reserved' },
  ]) {
    const waiting = { ...t, status, lease_owner: null, lease_until: null }
    const updated = { ...waiting, cancel_requested_at: now, revision: '2' }
    const steps: Step[] = [actor, [/FROM agent_turns .*t.id=\$2$/, [waiting]], lockedSession, [/FOR UPDATE OF t/, [waiting]],
      [/FROM agent_tool_calls .*FOR UPDATE/, [{ id: mid, status: toolStatus }]],
      [/FROM agent_approvals .*FOR UPDATE/, approvalStatus ? [{ id: mid, status: approvalStatus }] : []],
      [/FROM agent_budget_reservations .*FOR UPDATE/, [{ id: mid, status: reservationStatus }]],
      [/UPDATE agent_turns SET cancel_requested_at=clock_timestamp\(\),revision=revision\+1/, [updated]], ...eventSteps('3'), wakeStep]
    const f = fixture(steps)
    const result = await f.repo.cancel(owner, tid)
    assert.equal(result.status, status)
    assert.equal(f.calls.find(c => /UPDATE agent_turns/.test(c.sql))!.args[2], false)
    assert.doesNotMatch(f.calls.map(c => c.sql).join(''), /UPDATE agent_sessions SET active_turn_id=NULL|SET lease_/)
    f.done()
  }
})

test('agent-core: local cancel fails closed for each unfinished/unknown dependency and lease, even without other dependencies', async () => {
  const cases = [
    ...['recorded', 'validating', 'waiting_approval', 'queued', 'executing', 'waiting_external', 'unexpected'].map(status => ({ tools: [{ status }], approvals: [], reservations: [], lease_owner: null, lease_until: null, local: false })),
    { tools: [], approvals: [{ status: 'pending' }], reservations: [], lease_owner: null, lease_until: null, local: false },
    ...['reserved', 'unknown', 'unexpected'].map(status => ({ tools: [], approvals: [], reservations: [{ status }], lease_owner: null, lease_until: null, local: false })),
    { tools: [], approvals: [], reservations: [], lease_owner: 'retained', lease_until: now, local: false },
    { tools: [], approvals: [], reservations: [], lease_owner: null, lease_until: now, local: false },
    { tools: ['completed', 'failed', 'skipped', 'cancelled'].map(status => ({ status })), approvals: ['approved', 'rejected', 'expired'].map(status => ({ status })),
      reservations: ['settled', 'released'].map(status => ({ status })), lease_owner: null, lease_until: null, local: true },
  ]
  for (const input of cases) {
    const prior = { ...t, lease_owner: input.lease_owner, lease_until: input.lease_until }
    const f = fixture([actor, [/FROM agent_turns .*t.id=\$2$/, [prior]], lockedSession, [/FOR UPDATE OF t/, [prior]],
      [/FROM agent_tool_calls .*FOR UPDATE/, input.tools], [/FROM agent_approvals .*FOR UPDATE/, input.approvals],
      [/FROM agent_budget_reservations .*FOR UPDATE/, input.reservations],
      [/UPDATE agent_turns/, [{ ...prior, status: input.local ? 'cancelled' : 'queued', cancel_requested_at: now, revision: '2' }]],
      ...(input.local ? [[/UPDATE agent_sessions SET active_turn_id=NULL/, []] as Step] : []), ...eventSteps('3'), ...(input.local ? [] : [wakeStep])])
    await f.repo.cancel(owner, tid)
    assert.equal(f.calls.find(c => /UPDATE agent_turns/.test(c.sql))!.args[2], input.local, JSON.stringify(input))
    assert.doesNotMatch(f.calls.map(c => c.sql).join(''), /UPDATE agent_tool_calls|UPDATE agent_approvals|UPDATE agent_budget_reservations|lease_owner=/)
    f.done()
  }
})

function approvalFixture(expired = false, decision: string = 'pending') {
  const hash = canvasAgentRequestDigest({})
  const a = { id: mid, session_id: sid, turn_id: tid, tool_call_id: mid, arguments_hash: hash, model_revision: mid,
    pricing_revision: 'pricing:1', reservation_id: mid, status: decision, expires_at: now, resolved_at: null, resolved_by: null, expired }
  const steps: Step[] = [actor, [/SELECT a.turn_id,a.tool_call_id FROM agent_approvals .*s.owner_id=\$1/, [a]], lookupTurn, lockedSession, lockedTurn,
    [/FROM agent_tool_calls .*FOR UPDATE/, [{ id: mid, arguments: {}, arguments_hash: hash, status: 'waiting_approval' }]], [/FROM agent_approvals .*FOR UPDATE/, [a]]]
  return { a, hash, steps }
}
test('agent-core: expired approval returns a committed visible expiry and keeps turn dependency state; only decision intent wakes', async () => {
  const { a, hash, steps } = approvalFixture(true)
  const f = fixture([...steps, [/FROM agent_budget_reservations .*FOR UPDATE/, [{ status: 'reserved', pricing_revision: a.pricing_revision }]],
    [/UPDATE agent_approvals SET status=CASE WHEN expires_at<=decision_time.at THEN 'expired'/, [{ ...a, status: 'expired', resolved_at: now }]],
    [/UPDATE agent_turns SET revision=revision\+1/, [{ ...t, revision: '2' }]], ...eventSteps('3'), ...eventSteps('4'), wakeStep])
  const result = await f.repo.resolveApproval(owner, mid, { decision: 'approved', expectedArgumentsHash: hash })
  assert.equal(result.expired, true); assert.equal(result.approval.status, 'expired')
  assert.doesNotMatch(f.calls.map(c => c.sql).join(''), /SET status='queued'|INSERT INTO generation_jobs|UPDATE agent_tool_calls/); f.done()
})
test('agent-core: repeated identical approval decision is read-only; opposite decision conflicts', async () => {
  const first = approvalFixture(false, 'approved'), f = fixture(first.steps)
  assert.equal((await f.repo.resolveApproval(owner, mid, { decision: 'approved', expectedArgumentsHash: first.hash })).approval.status, 'approved'); f.done()
  const next = approvalFixture(false, 'approved'), other = fixture(next.steps)
  await assert.rejects(other.repo.resolveApproval(owner, mid, { decision: 'rejected', expectedArgumentsHash: next.hash }), { code: 'CONFLICT' }); other.done()
})
test('agent-core: decided approval replay freezes its original revision after unrelated steering/decisions; expiry replay is also stable', async () => {
  for (const status of ['approved', 'expired']) {
    const { a, hash, steps } = approvalFixture(status === 'expired', status)
    a.resolved_at = now as never
    steps[2] = [/FROM agent_turns/, [{ ...t, revision: '99' }]]
    steps[4] = [/FOR UPDATE OF t/, [{ ...t, revision: '99' }]]
    steps[6] = [/FROM agent_approvals .*FOR UPDATE/, [{ ...a, decision_revision: '2' }]]
    const f = fixture(steps)
    const result = await f.repo.resolveApproval(owner, mid, { decision: 'approved', expectedArgumentsHash: hash })
    assert.equal(result.approval.revision, '2'); assert.equal(result.expired, status === 'expired')
    assert.equal(f.calls.some(c => /^(UPDATE|INSERT)/.test(c.sql.trim())), false); f.done()
  }
})
test('agent-core: owner scope rejects before exposing cursor bounds; ahead, retention, gaps and bigint remain precise', async () => {
  const missing = fixture([[/FROM agent_sessions WHERE owner_id=\$1 AND id=\$2$/, []]])
  await assert.rejects(missing.repo.events(owner, sid, '9223372036854775807', 10), { code: 'NOT_FOUND' }); missing.done()
  const ahead = fixture([[/FROM agent_sessions/, [s]]])
  await assert.rejects(ahead.repo.events(owner, sid, '3', 10), { code: 'CURSOR_AHEAD' }); ahead.done()
  const retained = fixture([[/FROM agent_sessions/, [{ ...s, event_retention_floor: '1' }]]])
  assert.equal((await retained.repo.events(owner, sid, '0', 10)).resyncRequired, true); retained.done()
  const gap = fixture([[/FROM agent_sessions/, [s]], [/FROM agent_session_events/, [{ cursor: '2' }]]])
  assert.equal((await gap.repo.events(owner, sid, '0', 10)).resyncRequired, true); gap.done()
  const big = '9007199254740993'
  const complete = fixture([[/FROM agent_sessions/, [{ ...s, next_event_cursor: '9007199254740994' }]], [/FROM agent_session_events/, []]])
  assert.equal((await complete.repo.events(owner, sid, big, 10)).highWater, big); complete.done()
  for (const input of ['01', '-1', '1e3', ' 1', '9223372036854775808', '9'.repeat(100)]) assert.throws(() => agentCoreDecimal(input), AgentCoreError)
})
test('agent-core: snapshot uses single repeatable-read port and advertises bounded history without dropping the high water', async () => {
  const f = fixture([[/FROM agent_sessions/, [{ ...s, active_turn_id: null }]], [/FROM agent_items .*sequence>\$2 AND sequence<\$3 ORDER BY sequence LIMIT \$4/,
    [1, 2].map(x => ({ id: mid, session_id: sid, turn_id: null, sequence: String(x), item_type: 'user_message', tool_call_id: null, payload: { content: 'public', config_snapshot: 'secret' }, created_at: now }))]])
  const result = await f.repo.snapshot(owner, sid, 1)
  assert.deepEqual(f.modes, [true]); assert.equal(result.itemsHasMore, true); assert.equal(result.nextItemsCursor, '1'); assert.equal(result.eventCursor, '2')
  assert.deepEqual(result.items[0]!.payload, { content: 'public' }); f.done()
})
test('agent-core: 0043 adds immutable request receipts, owner FK, monotonic retention and approval binding (SQL source, not PG execution)', () => {
  const sql = readFileSync(new URL('../../migrations/0043_agent_control_plane.sql', import.meta.url), 'utf8')
  assert.match(sql, /PRIMARY KEY\(owner_id, client_request_key\)/)
  assert.match(sql, /PRIMARY KEY\(session_id, client_message_id\)/)
  assert.match(sql, /FOREIGN KEY\(session_id, owner_id\)/)
  assert.match(sql, /accepted_response jsonb/)
  assert.match(sql, /NEW.event_retention_floor < OLD.event_retention_floor/)
  assert.match(sql, /immutable agent approval binding/)
  assert.match(sql, /UPDATE agent_approvals a SET decision_revision=t.revision FROM agent_turns t/)
  assert.match(sql, /status<>'pending' AND decision_revision IS NOT NULL AND decision_revision>0/)
  assert.match(sql, /OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD/)
  assert.doesNotMatch(sql, /INSERT INTO|UPDATE users|agent_legacy_links/)
  assert.match(readFileSync(new URL('../../rollback/0043_agent_control_plane.sql', import.meta.url), 'utf8'), /DROP TABLE IF EXISTS agent_message_receipts/)
})
test('agent-core: turn error projection exposes only allowlisted codes and fixed public messages', () => {
  const failed = agentTurnDTO({ ...t, status: 'failed', terminal_at: now,
    error: { code: 'DEADLINE_EXCEEDED', message: 'provider body token=secret', retryable: false } })
  assert.deepEqual(failed.error, { code: 'DEADLINE_EXCEEDED', message: 'Agent turn deadline was exceeded', retryable: false })
  const unknown = agentTurnDTO({ ...t, error: { code: 'PROVIDER_SECRET', message: 'https://signed.example/secret', retryable: true } })
  assert.deepEqual(unknown.error, { code: 'TOOL_FAILED', message: 'Agent tool execution failed', retryable: true })
  assert.equal(agentTurnDTO({ ...t, error: null }).error, null)
})
test('agent-core: steering and approval decisions are rejected after the frozen deadline', async () => {
  const late = { ...t, status: 'running', lease_owner: 'runner', deadline_open: false }
  const steer = fixture([actor, lockedSession, [/FROM agent_message_receipts/, []], [/FROM agent_turns .*FOR UPDATE OF t/, [late]]])
  await assert.rejects(steer.repo.message(owner, sid, { clientMessageId: mid, content: 'late steer' }, false), { code: 'CONFLICT' })
  assert.doesNotMatch(steer.calls.map(c => c.sql).join(''), /INSERT INTO agent_items|UPDATE agent_sessions SET input_revision|INSERT INTO outbox_events/)
  steer.done()

  const { a, hash } = approvalFixture()
  const approval = fixture([actor, [/SELECT a.turn_id,a.tool_call_id FROM agent_approvals .*s.owner_id=\$1/, [a]],
    [/FROM agent_turns t JOIN agent_sessions s .*t.id=\$2$/, [late]],
    lockedSession, [/FOR UPDATE OF t/, [late]], [/FROM agent_tool_calls .*FOR UPDATE/, [{ id: mid, arguments: {}, arguments_hash: hash, status: 'waiting_approval' }]],
    [/FROM agent_approvals .*FOR UPDATE/, [a]]])
  await assert.rejects(approval.repo.resolveApproval(owner, mid, { decision: 'approved', expectedArgumentsHash: hash }), { code: 'CONFLICT' })
  assert.doesNotMatch(approval.calls.map(c => c.sql).join(''), /UPDATE agent_approvals SET|INSERT INTO outbox_events/)
  approval.done()
})
