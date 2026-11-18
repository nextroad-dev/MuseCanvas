import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentMediaEventHandler } from './media-events'
import type { AgentMediaEventDependencies, AgentSqlClient } from './ports'

const eventId = '11111111-1111-4111-8111-111111111111'
const jobId = '22222222-2222-4222-8222-222222222222'
const ownerId = 'owner', sessionId = 'session', turnId = 'turn', toolId = 'tool'
type Job = { id: string; status: string; completed_at: string | null; created_by: string; owner_id: string }
function fixture() {
  const state = { receipts: [] as string[], results: [] as string[], wakes: 0, roundCompleted: false, toolStatus: 'waiting_external' }
  const controls = { actorStatus: 'active', actorDeleted: false, dependencies: true, active: true, terminalTurn: false, cancelRequested: false, failRecord: false, failWake: false, failCommit: false,
    roundHasOtherTool: false, outputMissing: false, cycleChanged: false }
  const jobs: Job[] = [{ id: jobId, status: 'succeeded', completed_at: 'terminal', created_by: ownerId, owner_id: ownerId },
    { id: 'other-job', status: 'running', completed_at: null, created_by: ownerId, owner_id: ownerId }]
  const calls: string[] = []
  let staged = structuredClone(state)
  let discoveries = 0
  const client: AgentSqlClient = { async query(sql, params = []) {
    calls.push(sql)
    const rows = (values: Record<string, unknown>[] = []) => ({ rows: values, rowCount: values.length })
    if (sql.includes('SELECT event_id FROM agent_consumed_events')) return rows(staged.receipts.includes(String(params[1])) ? [{ event_id: params[1] }] : [])
    if (sql.includes('SELECT DISTINCT l.owner_id')) {
      discoveries++
      if (controls.cycleChanged && discoveries > 1) return rows()
      return rows(controls.dependencies ? [{ owner_id: ownerId, session_id: sessionId, turn_id: turnId, tool_call_id: toolId }] : [])
    }
    if (sql.includes('FROM users')) { assert.match(sql, /status,deleted_at.*FOR NO KEY UPDATE/); return rows([{ id: ownerId, status: controls.actorStatus, deleted_at: controls.actorDeleted ? 'deleted' : null }]) }
    if (sql.includes('FROM agent_sessions')) return rows([{ active_turn_id: controls.active ? turnId : 'new-turn', archived_at: null }])
    if (sql.includes('FROM agent_turns')) return rows([{ status: controls.terminalTurn ? 'completed' : 'waiting_tools', cancel_requested_at: controls.cancelRequested ? 'cancel' : null }])
    if (sql.includes('FROM agent_tool_calls')) return rows([{ status: staged.toolStatus }])
    if (sql.includes('FROM agent_tool_job_links l JOIN generation_jobs')) { assert.match(sql, /FOR SHARE OF j/); return rows(jobs) }
    if (sql.includes('FROM generation_outputs')) return rows(controls.outputMissing ? [] : [{ id: `asset:${params[0]}` }])
    if (sql.includes('INSERT INTO agent_consumed_events')) { if (!staged.receipts.includes(String(params[1]))) staged.receipts.push(String(params[1])); return rows() }
    assert.fail(`Unexpected SQL: ${sql}`)
  } }
  const deps: AgentMediaEventDependencies = {
    async transaction(work) {
      staged = structuredClone(state)
      const result = await work(client)
      if (controls.failCommit) throw new Error('COMMIT_FAILED')
      Object.assign(state, structuredClone(staged))
      return result
    },
    settlement: {
      async recordToolResult(sql, input) {
        assert.equal(sql, client)
        if (controls.failRecord) throw new Error('RESULT_FAILED')
        assert.equal(input.idempotencyKey, `media-result:${toolId}`)
        assert.equal(input.result!.jobs instanceof Array && input.result!.jobs.length, 2)
        assert.equal(typeof input.result!.content, 'string', 'display projection includes visible content')
        const recorded = !staged.results.includes(input.toolCallId)
        if (recorded) staged.results.push(input.toolCallId)
        staged.toolStatus = input.status
        return { recorded, finalResult: true }
      },
      async queueIfDependenciesTerminal(sql, scope) {
        assert.equal(sql, client)
        assert.equal(scope.ownerId, ownerId)
        if (controls.failWake) throw new Error('WAKE_FAILED')
        if (controls.roundHasOtherTool) return null
        staged.roundCompleted = true
        staged.wakes++
        return { sessionId, turnId, revision: '2' }
      },
    },
  }
  return { handler: createAgentMediaEventHandler(deps), state, controls, jobs, calls }
}

test('media completion waits for ALL jobs, then commits one final result/round/wake; duplicate deliveries do nothing', async () => {
  const f = fixture()
  assert.equal(await f.handler({ eventId, jobId }), 'ack')
  assert.deepEqual(f.state.results, [])
  assert.equal(f.state.wakes, 0)
  f.jobs[1].status = 'succeeded'; f.jobs[1].completed_at = 'terminal'
  const secondEvent = '33333333-3333-4333-8333-333333333333'
  assert.equal(await f.handler({ eventId: secondEvent, jobId }), 'ack')
  assert.deepEqual(f.state.results, [toolId])
  assert.equal(f.state.wakes, 1)
  assert.equal(f.state.roundCompleted, true)
  assert.equal(await f.handler({ eventId: secondEvent, jobId }), 'ack')
  assert.equal(await f.handler({ eventId: '44444444-4444-4444-8444-444444444444', jobId }), 'ack')
  assert.equal(f.state.results.length, 1)
  assert.equal(f.state.wakes, 1)
})

test('final failure/cancel settles once, while complete-round gate can retain other tool dependencies', async () => {
  for (const status of ['failed', 'canceled']) {
    const f = fixture()
    f.jobs[1].status = status; f.jobs[1].completed_at = 'terminal'
    f.controls.roundHasOtherTool = true
    assert.equal(await f.handler({ eventId, jobId }), 'ack')
    assert.equal(f.state.toolStatus, status === 'failed' ? 'failed' : 'cancelled')
    assert.equal(f.state.wakes, 0)
    assert.equal(f.state.roundCompleted, false)
  }
})

test('untrusted/missing links, wrong owners, inactive/terminal/cancelling Turns and stale terminal cycles cannot settle or reopen', async () => {
  for (const control of ['dependencies', 'active', 'terminalTurn', 'cancelRequested', 'cycleChanged'] as const) {
    const f = fixture()
    f.jobs[1].status = 'failed'; f.jobs[1].completed_at = 'terminal'
    f.controls[control] = !f.controls[control]
    assert.equal(await f.handler({ eventId, jobId }), 'ack')
    assert.deepEqual(f.state.results, [])
    assert.equal(f.state.wakes, 0)
  }
  const wrongOwner = fixture()
  wrongOwner.jobs[1].created_by = 'other-owner'
  assert.equal(await wrongOwner.handler({ eventId, jobId }), 'ack')
  assert.deepEqual(wrongOwner.state.results, [])
  assert.equal(await wrongOwner.handler({ eventId: 'not-a-uuid', jobId }), 'ack')
})

test('result/wake/commit failures roll back dedupe and result, redelivery completes once', async () => {
  for (const control of ['failRecord', 'failWake', 'failCommit'] as const) {
    const f = fixture()
    f.jobs[1].status = 'succeeded'; f.jobs[1].completed_at = 'terminal'
    f.controls[control] = true
    assert.equal(await f.handler({ eventId, jobId }), 'retry')
    assert.equal(f.state.receipts.length, 0)
    assert.equal(f.state.results.length, 0)
    assert.equal(f.state.wakes, 0)
    f.controls[control] = false
    assert.equal(await f.handler({ eventId, jobId }), 'ack')
    assert.equal(f.state.results.length, 1)
    assert.equal(f.state.wakes, 1)
  }
})

test('completion before waiting_external or without committed success outputs retries without a durable receipt', async () => {
  for (const earlyTool of [true, false]) {
    const f = fixture()
    f.jobs[1].status = 'succeeded'; f.jobs[1].completed_at = 'terminal'
    if (earlyTool) f.state.toolStatus = 'executing'
    else f.controls.outputMissing = true
    assert.equal(await f.handler({ eventId, jobId }), 'retry')
    assert.deepEqual(f.state.receipts, [])
    assert.deepEqual(f.state.results, [])
  }
})


test('disabled/deleted actor cannot record normal media result or wake; cleanup stays with M5', async () => {
  for (const deleted of [false, true]) {
    const f = fixture()
    f.jobs[1].status = 'succeeded'; f.jobs[1].completed_at = 'terminal'
    if (deleted) f.controls.actorDeleted = true
    else f.controls.actorStatus = 'disabled'
    assert.equal(await f.handler({ eventId, jobId }), 'ack')
    assert.deepEqual(f.state.results, [])
    assert.equal(f.state.wakes, 0)
    assert.equal(f.state.roundCompleted, false)
    assert.ok(!f.calls.some(sql => sql.includes('FROM agent_sessions')))
  }
})
