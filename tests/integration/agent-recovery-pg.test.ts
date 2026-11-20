import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runMigrations, type MigrateOptions } from '../../packages/database/src/migrations/runner'
import type { AgentCoreTransaction } from '../../packages/database/src/repositories/agent-core'
import { AgentMediaRecoveryRepository } from '../../packages/database/src/repositories/agent-media-recovery'
import { AgentRecoveryRepository } from '../../packages/database/src/repositories/agent-recovery'

const url = process.env.MUSECANVAS_AGENT_RECOVERY_PG_URL

// Source/typecheck only until an operator supplies this dedicated opt-in URL.
// Never use inherited DATABASE_URL, load env files, or start any service. Match
// the existing fixtures: loopback fixture user, fresh owned database, dropped in
// the finally block.
test('isolated PostgreSQL: Agent recovery persistence sweeps', { skip: !url, timeout: 180_000 }, async t => {
  const target = new URL(url!)
  assert.equal(target.hostname, '127.0.0.1')
  assert.equal(target.username, 'fixture')
  assert.equal(target.pathname, '/postgres')
  const require = createRequire(new URL('../../packages/database/package.json', import.meta.url))
  type Pool = MigrateOptions['pool']
  const { Pool } = require('pg') as { Pool: new (config: { connectionString: string; max: number; connectionTimeoutMillis: number; statement_timeout?: number; lock_timeout?: number }) => Pool }
  const admin = new Pool({ connectionString: url!, max: 1, connectionTimeoutMillis: 5000 })
  const name = `agent_recovery_${randomUUID().replaceAll('-', '')}`
  assert.match(name, /^agent_recovery_[a-f0-9]{32}$/)
  let pool: Pool | undefined, created = false
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    created = true
    target.pathname = `/${name}`
    pool = new Pool({ connectionString: target.toString(), max: 6, connectionTimeoutMillis: 5000, statement_timeout: 5000, lock_timeout: 3000 })
    const fixturePool = pool
    const latest = (await runMigrations({ pool: fixturePool })).latest
    assert.ok(latest && latest >= '0044', `Agent recovery fixture requires migrations through 0044, got ${latest}`)
    const tx: AgentCoreTransaction = async work => {
      const c = await fixturePool.connect()
      try { await c.query('BEGIN'); const value = await work(c); await c.query('COMMIT'); return value }
      catch (error) { await c.query('ROLLBACK'); throw error }
      finally { c.release() }
    }
    const recovery = new AgentRecoveryRepository(tx)
    const mediaRecovery = new AgentMediaRecoveryRepository(tx)
    type Row = Record<string, any>
    async function one<T extends Row>(sql: string, args: unknown[] = []): Promise<T> {
      const row = (await fixturePool.query<T>(sql, args)).rows[0]
      assert.ok(row)
      return row
    }
    async function many<T extends Row>(sql: string, args: unknown[] = []): Promise<T[]> {
      return (await fixturePool.query<T>(sql, args)).rows
    }

    const { ownerId, definitionId, modelId } = await tx(async c => {
      const owner = (await c.query<{ id: string }>("INSERT INTO users(email) VALUES('agent-recovery@example.invalid') RETURNING id")).rows[0]
      assert.ok(owner)
      const definition = (await c.query<{ id: string }>(`INSERT INTO agent_definitions(name,version,model_policy,instructions,tool_allowlist,budget_policy)
        VALUES('recovery-fixture',1,'{}','','[]','{}') RETURNING id`)).rows[0]
      assert.ok(definition)
      const model = (await c.query<{ id: string }>(`INSERT INTO model_configs(display_name,adapter,vendor_model_id,sizes,max_count,concurrency_limit,created_by)
        VALUES('recovery-fixture-model','openai','recovery-fixture','["1024x1024"]',1,1,$1) RETURNING id`, [owner.id])).rows[0]
      assert.ok(model)
      return { ownerId: owner.id, definitionId: definition.id, modelId: model.id }
    })

    interface TurnScope { sessionId: string; turnId: string }
    async function makeTurn(options: {
      status: string
      deadline: 'past' | 'future'
      leaseOwner?: string | null
      leaseExpired?: boolean
      cancelRequested?: boolean
      active?: boolean
      fencingToken?: number
    }): Promise<TurnScope> {
      return tx(async c => {
        const session = (await c.query<{ id: string }>(
          'INSERT INTO agent_sessions(owner_id,agent_definition_id,definition_version) VALUES($1,$2,1) RETURNING id',
          [ownerId, definitionId])).rows[0]
        assert.ok(session)
        const deadline = options.deadline === 'past' ? "clock_timestamp()-interval '1 minute'" : "clock_timestamp()+interval '5 minutes'"
        const turn = (await c.query<{ id: string }>(`INSERT INTO agent_turns(session_id,client_idempotency_key,request_digest,status,config_snapshot,budget_snapshot,engine_version,input_revision,deadline_at,lease_owner,lease_until,cancel_requested_at,fencing_token)
          VALUES($1,$2,$3,$4,'{}','{}','agent-core-v1',1,${deadline},$5,
            CASE WHEN $5::text IS NULL THEN NULL WHEN $6 THEN clock_timestamp()-interval '1 minute' ELSE clock_timestamp()+interval '5 minutes' END,
            CASE WHEN $7 THEN clock_timestamp() ELSE NULL END,$8) RETURNING id`,
        [session.id, randomUUID(), 'a'.repeat(64), options.status, options.leaseOwner ?? null,
          options.leaseExpired === true, options.cancelRequested === true, options.fencingToken ?? 0])).rows[0]
        assert.ok(turn)
        if (options.active) await c.query('UPDATE agent_sessions SET active_turn_id=$2 WHERE id=$1', [session.id, turn.id])
        return { sessionId: session.id, turnId: turn.id }
      })
    }

    async function makeTool(scope: TurnScope, options: {
      status: string
      roundPosition: number
      toolName?: string
      position?: number
      argumentsHash?: string
    }): Promise<{ toolId: string; argumentsHash: string }> {
      const toolId = randomUUID(), roundId = randomUUID(), argumentsHash = options.argumentsHash ?? 'b'.repeat(64)
      await tx(async c => {
        await c.query(`INSERT INTO agent_model_rounds(id,session_id,turn_id,position,request_digest,input_revision,status,model_reference_id)
          VALUES($1,$2,$3,$4,$5,1,'recorded','fixture')`,
        [roundId, scope.sessionId, scope.turnId, options.roundPosition, 'c'.repeat(64)])
        await c.query(`INSERT INTO agent_tool_calls(id,session_id,turn_id,round_id,position,provider_call_id,tool_name,tool_schema_version,arguments,arguments_hash,status,idempotency_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,1,'{}',$8,$9,$10)`,
        [toolId, scope.sessionId, scope.turnId, roundId, options.position ?? 0, `call:${toolId}`,
          options.toolName ?? 'fixture_tool', argumentsHash, options.status, `idem:${toolId}`])
      })
      return { toolId, argumentsHash }
    }

    async function reserve(scope: TurnScope, toolId: string, quota: string, amount: number, pricingRevision: string | null = null): Promise<string> {
      const id = randomUUID()
      await tx(c => c.query(`INSERT INTO agent_budget_reservations(id,session_id,turn_id,tool_call_id,quota,reserved_amount,currency,pricing_revision,status,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9)`,
      [id, scope.sessionId, scope.turnId, toolId, quota, String(amount),
        quota === 'estimated_cost' ? 'USD' : null, pricingRevision, `res:${id}`]))
      return id
    }

    async function makeApproval(scope: TurnScope, tool: { toolId: string; argumentsHash: string }, reservationId: string,
      expires: 'past' | 'future', pricingRevision = 'fixture-pricing-1'): Promise<string> {
      const id = randomUUID()
      const expiresAt = expires === 'past' ? "clock_timestamp()-interval '1 minute'" : "clock_timestamp()+interval '5 minutes'"
      await tx(c => c.query(`INSERT INTO agent_approvals(id,session_id,turn_id,tool_call_id,arguments_hash,model_revision,pricing_revision,reservation_id,status,expires_at)
        VALUES($1,$2,$3,$4,$5,'fixture-model-revision',$6,$7,'pending',${expiresAt})`,
      [id, scope.sessionId, scope.turnId, tool.toolId, tool.argumentsHash, pricingRevision, reservationId]))
      return id
    }

    async function makeJob(status: 'succeeded' | 'failed' | 'running'): Promise<{ jobId: string; assetId: string | null }> {
      const jobId = randomUUID()
      let assetId: string | null = null
      await tx(async c => {
        await c.query(`INSERT INTO generation_jobs(id,created_by,model_id,model_name,adapter,vendor_model_id,prompt,size,quality,count,status,idempotency_key)
          VALUES($1,$2,$3,'recovery-fixture-model','openai','recovery-fixture','fixture','1024x1024',NULL,1,$4::job_status,$5)`,
        [jobId, ownerId, modelId, status, `job:${jobId}`])
        if (status === 'succeeded') {
          assetId = randomUUID()
          await c.query(`INSERT INTO assets(id,created_by,job_id,object_key,mime_type,width,height,size_bytes,checksum)
            VALUES($1,$2,$3,$4,'image/png',1024,1024,1024,$5)`,
          [assetId, ownerId, jobId, `recovery/${assetId}`, 'd'.repeat(64)])
          await c.query('INSERT INTO generation_outputs(job_id,asset_id) VALUES($1,$2)', [jobId, assetId])
        }
      })
      return { jobId, assetId }
    }

    async function makeLink(scope: TurnScope, toolId: string, jobId: string, position: number): Promise<void> {
      await tx(c => c.query(`INSERT INTO agent_tool_job_links(tool_call_id,session_id,turn_id,owner_id,media_job_id,position,dependency_role)
        VALUES($1,$2,$3,$4,$5,$6,'media')`, [toolId, scope.sessionId, scope.turnId, ownerId, jobId, position]))
    }

    async function sessionState(scope: TurnScope) {
      return one<{ active_turn_id: string | null; next_event_cursor: string }>(
        'SELECT active_turn_id,next_event_cursor::text FROM agent_sessions WHERE id=$1', [scope.sessionId])
    }
    async function events(scope: TurnScope) {
      return many<{ cursor: string; event_type: string; entity_revision: string | null; payload: Row }>(
        'SELECT cursor::text,event_type,entity_revision::text,payload FROM agent_session_events WHERE session_id=$1 ORDER BY cursor',
        [scope.sessionId])
    }
    async function wakes(turnId: string) {
      return many<{ event_type: string; dedupe_key: string | null; payload: Row }>(
        'SELECT event_type,dedupe_key,payload FROM outbox_events WHERE aggregate_id=$1 ORDER BY created_at', [turnId])
    }

    await t.test('expireDeadlines fails the turn and local tool, expires approval, releases only local budget', async () => {
      const scope = await makeTurn({ status: 'waiting_tools', deadline: 'past', leaseOwner: 'deadline-worker', active: true })
      const local = await makeTool(scope, { status: 'executing', roundPosition: 1, toolName: 'local_fixture' })
      const external = await makeTool(scope, { status: 'waiting_external', roundPosition: 2, toolName: 'external_fixture' })
      const job = await makeJob('running')
      await makeLink(scope, external.toolId, job.jobId, 0)
      const localReservation = await reserve(scope, local.toolId, 'tool_calls', 1, 'fixture-pricing-1')
      const externalReservation = await reserve(scope, external.toolId, 'media_jobs', 1)
      const approvalId = await makeApproval(scope, local, localReservation, 'future')

      const outcome = await recovery.expireDeadlines(10)
      assert.deepEqual(outcome, { kind: 'deadline', processed: 1, remaining: false })

      const turn = await one<{ status: string; revision: string; error: Row; terminal_at: unknown; lease_owner: string | null; lease_until: unknown }>(
        'SELECT status,revision::text,error,terminal_at,lease_owner,lease_until FROM agent_turns WHERE id=$1', [scope.turnId])
      assert.equal(turn.status, 'failed')
      assert.equal(turn.revision, '2')
      assert.equal(turn.error.code, 'DEADLINE_EXCEEDED')
      assert.ok(turn.terminal_at)
      assert.equal(turn.lease_owner, null)
      assert.equal(turn.lease_until, null)

      const session = await sessionState(scope)
      assert.equal(session.active_turn_id, null)

      const localTool = await one<{ status: string; error: Row }>('SELECT status,error FROM agent_tool_calls WHERE id=$1', [local.toolId])
      assert.equal(localTool.status, 'failed')
      assert.equal(localTool.error.code, 'DEADLINE_EXCEEDED')
      const externalTool = await one<{ status: string; error: Row | null }>(
        'SELECT status,error FROM agent_tool_calls WHERE id=$1', [external.toolId])
      assert.equal(externalTool.status, 'waiting_external')
      assert.equal(externalTool.error, null)

      const approval = await one<{ status: string; decision_revision: string; resolved_at: unknown }>(
        'SELECT status,decision_revision::text,resolved_at FROM agent_approvals WHERE id=$1', [approvalId])
      assert.equal(approval.status, 'expired')
      assert.ok(Number(approval.decision_revision) > 0)
      assert.equal(approval.decision_revision, '2')
      assert.ok(approval.resolved_at)

      const localBudget = await one<{ status: string; settled_at: unknown }>(
        'SELECT status,settled_at FROM agent_budget_reservations WHERE id=$1', [localReservation])
      assert.equal(localBudget.status, 'released')
      assert.ok(localBudget.settled_at)
      const externalBudget = await one<{ status: string; settled_at: unknown }>(
        'SELECT status,settled_at FROM agent_budget_reservations WHERE id=$1', [externalReservation])
      assert.equal(externalBudget.status, 'reserved')
      assert.equal(externalBudget.settled_at, null)

      const stored = await events(scope)
      assert.deepEqual(stored.map(event => event.event_type), ['item.created', 'tool.updated', 'approval.required', 'turn.updated'])
      assert.deepEqual(stored.map(event => event.cursor), ['1', '2', '3', '4'])
      assert.deepEqual(stored.map(event => event.entity_revision), ['2', '2', '2', '2'])
      assert.equal(stored[0]!.payload.item.type, 'tool_result')
      assert.equal(stored[0]!.payload.item.toolCallId, local.toolId)
      assert.equal(stored[1]!.payload.tool.id, local.toolId)
      assert.equal(stored[1]!.payload.tool.status, 'failed')
      assert.equal(stored[1]!.payload.tool.revision, '2')
      assert.equal(stored[2]!.payload.approval.id, approvalId)
      assert.equal(stored[2]!.payload.approval.status, 'expired')
      assert.equal(stored[3]!.payload.turn.status, 'failed')
      assert.equal(stored[3]!.payload.turn.revision, '2')
      assert.equal(session.next_event_cursor, '5')
      assert.equal(stored.at(-1)!.cursor, String(Number(session.next_event_cursor) - 1))
    })

    await t.test('expireApprovals re-queues once and wakes once; a second sweep is a no-op', async () => {
      const scope = await makeTurn({ status: 'waiting_approval', deadline: 'future', active: true })
      const tool = await makeTool(scope, { status: 'waiting_approval', roundPosition: 1, toolName: 'approval_fixture' })
      const reservation = await reserve(scope, tool.toolId, 'tool_calls', 1, 'fixture-pricing-2')
      const approvalId = await makeApproval(scope, tool, reservation, 'past', 'fixture-pricing-2')

      const outcome = await recovery.expireApprovals(10)
      assert.deepEqual(outcome, { kind: 'approval', processed: 1, remaining: false })

      const approval = await one<{ status: string; decision_revision: string; resolved_at: unknown }>(
        'SELECT status,decision_revision::text,resolved_at FROM agent_approvals WHERE id=$1', [approvalId])
      assert.equal(approval.status, 'expired')
      assert.ok(Number(approval.decision_revision) > 0)
      assert.ok(approval.resolved_at)

      const failedTool = await one<{ status: string; error: Row }>('SELECT status,error FROM agent_tool_calls WHERE id=$1', [tool.toolId])
      assert.equal(failedTool.status, 'failed')
      assert.equal(failedTool.error.code, 'APPROVAL_EXPIRED')
      const budget = await one<{ status: string }>('SELECT status FROM agent_budget_reservations WHERE id=$1', [reservation])
      assert.equal(budget.status, 'released')

      const turn = await one<{ status: string; revision: string; terminal_at: unknown }>(
        'SELECT status,revision::text,terminal_at FROM agent_turns WHERE id=$1', [scope.turnId])
      assert.equal(turn.status, 'queued')
      assert.equal(turn.revision, '3')
      assert.equal(turn.terminal_at, null)
      const session = await sessionState(scope)
      assert.equal(session.active_turn_id, scope.turnId)

      const stored = await events(scope)
      assert.deepEqual(stored.map(event => event.event_type), ['item.created', 'tool.updated', 'approval.required', 'turn.updated', 'turn.updated'])
      assert.equal(stored.at(-1)!.payload.turn.status, 'queued')
      assert.equal(stored.at(-1)!.payload.turn.revision, '3')
      assert.equal(session.next_event_cursor, '6')

      const firstWakes = await wakes(scope.turnId)
      assert.equal(firstWakes.length, 1)
      assert.equal(firstWakes[0]!.event_type, 'agent.turn.wake')
      assert.equal(firstWakes[0]!.dedupe_key, `agent:${scope.turnId}:${turn.revision}`)

      const again = await recovery.expireApprovals(10)
      assert.deepEqual(again, { kind: 'approval', processed: 0, remaining: false })
      assert.equal((await wakes(scope.turnId)).length, 1)
      assert.equal((await events(scope)).length, 5)
    })

    await t.test('finalizeCancellations cancels local work but leaves external media untouched', async () => {
      const scope = await makeTurn({ status: 'waiting_tools', deadline: 'future', cancelRequested: true, active: true })
      const local = await makeTool(scope, { status: 'executing', roundPosition: 1, toolName: 'cancel_local' })
      const external = await makeTool(scope, { status: 'waiting_external', roundPosition: 2, toolName: 'cancel_external' })
      const stray = await makeTool(scope, { status: 'waiting_external', roundPosition: 3, toolName: 'cancel_stray' })
      const job = await makeJob('running')
      await makeLink(scope, external.toolId, job.jobId, 0)
      const localReservation = await reserve(scope, local.toolId, 'tool_calls', 1)
      const externalReservation = await reserve(scope, external.toolId, 'media_jobs', 1)

      const outcome = await recovery.finalizeCancellations(10)
      assert.deepEqual(outcome, { kind: 'cancel', processed: 1, remaining: false })

      const turn = await one<{ status: string; revision: string; terminal_at: unknown; error: Row | null; lease_owner: string | null }>(
        'SELECT status,revision::text,terminal_at,error,lease_owner FROM agent_turns WHERE id=$1', [scope.turnId])
      assert.equal(turn.status, 'cancelled')
      assert.equal(turn.revision, '2')
      assert.ok(turn.terminal_at)
      assert.equal(turn.error, null)
      assert.equal(turn.lease_owner, null)
      assert.equal((await sessionState(scope)).active_turn_id, null)

      const localTool = await one<{ status: string; error: Row | null }>('SELECT status,error FROM agent_tool_calls WHERE id=$1', [local.toolId])
      assert.equal(localTool.status, 'cancelled')
      assert.deepEqual(localTool.error, { code: 'TOOL_FAILED', message: 'Agent tool cancelled', retryable: false })
      const externalTool = await one<{ status: string; error: Row | null }>('SELECT status,error FROM agent_tool_calls WHERE id=$1', [external.toolId])
      assert.equal(externalTool.status, 'waiting_external')
      assert.equal(externalTool.error, null)
      // The unlinked waiting_external mirror cannot outlive the cancelled turn.
      const strayTool = await one<{ status: string; error: Row }>('SELECT status,error FROM agent_tool_calls WHERE id=$1', [stray.toolId])
      assert.equal(strayTool.status, 'failed')
      assert.deepEqual(strayTool.error, { code: 'TOOL_FAILED', message: 'Media outcome was not observed before the turn ended', retryable: false })

      assert.equal((await one<{ status: string }>('SELECT status FROM agent_budget_reservations WHERE id=$1', [localReservation])).status, 'released')
      assert.equal((await one<{ status: string }>('SELECT status FROM agent_budget_reservations WHERE id=$1', [externalReservation])).status, 'reserved')
    })

    await t.test('recoverExpiredLeases clears the lease and re-emits exactly one wake without a public revision', async () => {
      const scope = await makeTurn({
        status: 'running', deadline: 'future', leaseOwner: 'expired-worker', leaseExpired: true, fencingToken: 4, active: true,
      })

      const outcome = await recovery.recoverExpiredLeases(10)
      assert.deepEqual(outcome, { kind: 'lease', processed: 1, remaining: false })

      const turn = await one<{ status: string; revision: string; fencing_token: string; lease_owner: string | null; lease_until: unknown; next_action_at: unknown; terminal_at: unknown }>(
        'SELECT status,revision::text,fencing_token::text,lease_owner,lease_until,next_action_at,terminal_at FROM agent_turns WHERE id=$1', [scope.turnId])
      assert.equal(turn.status, 'running')
      assert.equal(turn.revision, '1')
      assert.equal(turn.fencing_token, '4')
      assert.equal(turn.lease_owner, null)
      assert.equal(turn.lease_until, null)
      assert.ok(turn.next_action_at)
      assert.equal(turn.terminal_at, null)

      const session = await sessionState(scope)
      assert.equal(session.next_event_cursor, '1')
      assert.deepEqual(await events(scope), [])

      const emitted = await wakes(scope.turnId)
      assert.equal(emitted.length, 1)
      assert.equal(emitted[0]!.event_type, 'agent.turn.wake')
      assert.equal(emitted[0]!.dedupe_key, `agent-recovery:lease:${scope.turnId}:${turn.fencing_token}`)
    })

    await t.test('reconcileMediaJobs settles succeeded jobs and quota usage; an unknown cost estimate leaves the turn waiting', async () => {
      const scope = await makeTurn({ status: 'waiting_tools', deadline: 'future', active: true })
      const tool = await makeTool(scope, { status: 'waiting_external', roundPosition: 1, toolName: 'media_success' })
      const second = await makeJob('succeeded'), first = await makeJob('succeeded')
      assert.ok(second.assetId); assert.ok(first.assetId)
      await makeLink(scope, tool.toolId, second.jobId, 0)
      await makeLink(scope, tool.toolId, first.jobId, 1)
      const jobsReservation = await reserve(scope, tool.toolId, 'media_jobs', 2)
      const outputsReservation = await reserve(scope, tool.toolId, 'media_outputs', 2)
      const concurrentReservation = await reserve(scope, tool.toolId, 'concurrent_media_jobs', 1)
      const costReservation = await reserve(scope, tool.toolId, 'estimated_cost', 1.25, 'fixture-pricing-1')

      const outcome = await mediaRecovery.reconcileMediaJobs(10)
      assert.deepEqual(outcome, { kind: 'media', processed: 1, remaining: false })

      const completed = await one<{ status: string; result: Row | null; error: Row | null }>(
        'SELECT status,result,error FROM agent_tool_calls WHERE id=$1', [tool.toolId])
      assert.equal(completed.status, 'completed')
      assert.equal(completed.error, null)
      assert.deepEqual(completed.result, {
        jobIds: [second.jobId, first.jobId],
        assetIds: [second.assetId, first.assetId],
      })

      const budgets = new Map((await many<{ id: string; status: string; settled_at: unknown }>(
        'SELECT id,status,settled_at FROM agent_budget_reservations WHERE turn_id=$1', [scope.turnId]))
        .map(row => [row.id, row]))
      assert.equal(budgets.get(jobsReservation)!.status, 'settled')
      assert.ok(budgets.get(jobsReservation)!.settled_at)
      assert.equal(budgets.get(outputsReservation)!.status, 'settled')
      assert.ok(budgets.get(outputsReservation)!.settled_at)
      assert.equal(budgets.get(concurrentReservation)!.status, 'released')
      assert.equal(budgets.get(costReservation)!.status, 'unknown')
      assert.ok(budgets.get(costReservation)!.settled_at)

      const usage = await many<{ quota: string; amount: string; usage_kind: string }>(
        "SELECT details->>'quota' AS quota,amount::text,usage_kind FROM agent_usage_entries WHERE turn_id=$1", [scope.turnId])
      assert.equal(usage.length, 3)
      assert.deepEqual(Object.fromEntries(usage.map(entry => [entry.quota, Number(entry.amount)])), {
        media_jobs: 2, media_outputs: 2, estimated_cost: 1.25,
      })
      assert.deepEqual(Object.fromEntries(usage.map(entry => [entry.quota, entry.usage_kind])), {
        media_jobs: 'actual', media_outputs: 'actual', estimated_cost: 'unknown',
      })

      const turn = await one<{ status: string; revision: string; terminal_at: unknown }>(
        'SELECT status,revision::text,terminal_at FROM agent_turns WHERE id=$1', [scope.turnId])
      assert.equal(turn.status, 'waiting_tools')
      assert.equal(turn.revision, '2')
      assert.equal(turn.terminal_at, null)
      const session = await sessionState(scope)
      assert.equal(session.active_turn_id, scope.turnId)
      assert.equal(session.next_event_cursor, '3')

      const stored = await events(scope)
      assert.deepEqual(stored.map(event => event.event_type), ['item.created', 'tool.updated'])
      assert.equal(stored[0]!.payload.item.type, 'tool_result')
      assert.equal(stored[0]!.payload.item.toolCallId, tool.toolId)
      assert.equal(stored[1]!.payload.tool.status, 'completed')
      assert.equal(stored.at(-1)!.cursor, String(Number(session.next_event_cursor) - 1))

      // The unknown cost estimate is an unsettled reservation, so the requeue
      // gate (no reserved/unknown budget) leaves the turn waiting without a wake.
      const emitted = await wakes(scope.turnId)
      assert.equal(emitted.length, 0)

      const again = await mediaRecovery.reconcileMediaJobs(10)
      assert.deepEqual(again, { kind: 'media', processed: 0, remaining: false })
      assert.equal((await wakes(scope.turnId)).length, 0)
      assert.equal((await events(scope)).length, 2)
    })

    await t.test('reconcileMediaJobs resumes the turn once when every reservation settles (known zero price)', async () => {
      const scope = await makeTurn({ status: 'waiting_tools', deadline: 'future', active: true })
      const tool = await makeTool(scope, { status: 'waiting_external', roundPosition: 1, toolName: 'media_zero_cost' })
      const job = await makeJob('succeeded')
      assert.ok(job.assetId)
      await makeLink(scope, tool.toolId, job.jobId, 0)
      const jobsReservation = await reserve(scope, tool.toolId, 'media_jobs', 1)
      const outputsReservation = await reserve(scope, tool.toolId, 'media_outputs', 1)
      await reserve(scope, tool.toolId, 'concurrent_media_jobs', 1)
      const costReservation = await reserve(scope, tool.toolId, 'estimated_cost', 0, 'fixture-pricing-1')

      const outcome = await mediaRecovery.reconcileMediaJobs(10)
      assert.deepEqual(outcome, { kind: 'media', processed: 1, remaining: false })

      const budgets = new Map((await many<{ id: string; status: string }>(
        'SELECT id,status FROM agent_budget_reservations WHERE turn_id=$1', [scope.turnId])).map(row => [row.id, row]))
      assert.equal(budgets.get(jobsReservation)!.status, 'settled')
      assert.equal(budgets.get(outputsReservation)!.status, 'settled')
      assert.equal(budgets.get(costReservation)!.status, 'settled')

      const usage = await many<{ quota: string; amount: string; usage_kind: string }>(
        "SELECT details->>'quota' AS quota,amount::text,usage_kind FROM agent_usage_entries WHERE turn_id=$1", [scope.turnId])
      assert.equal(usage.length, 3)
      assert.deepEqual(Object.fromEntries(usage.map(entry => [entry.quota, Number(entry.amount)])), {
        media_jobs: 1, media_outputs: 1, estimated_cost: 0,
      })
      assert.ok(usage.every(entry => entry.usage_kind === 'actual'))

      const turn = await one<{ status: string; revision: string }>('SELECT status,revision::text FROM agent_turns WHERE id=$1', [scope.turnId])
      assert.equal(turn.status, 'queued')
      assert.equal(turn.revision, '3')
      const session = await sessionState(scope)
      assert.equal(session.active_turn_id, scope.turnId)
      assert.equal(session.next_event_cursor, '4')

      const stored = await events(scope)
      assert.deepEqual(stored.map(event => event.event_type), ['item.created', 'tool.updated', 'turn.updated'])
      assert.equal(stored.at(-1)!.payload.turn.status, 'queued')
      assert.equal(stored.at(-1)!.cursor, String(Number(session.next_event_cursor) - 1))

      const emitted = await wakes(scope.turnId)
      assert.equal(emitted.length, 1)
      assert.equal(emitted[0]!.event_type, 'agent.turn.wake')
      assert.equal(emitted[0]!.dedupe_key, `agent:${scope.turnId}:${turn.revision}`)

      const again = await mediaRecovery.reconcileMediaJobs(10)
      assert.deepEqual(again, { kind: 'media', processed: 0, remaining: false })
      assert.equal((await wakes(scope.turnId)).length, 1)
      assert.equal((await events(scope)).length, 3)
    })

    await t.test('reconcileMediaJobs fails a tool on a terminal failed job without a result', async () => {
      const scope = await makeTurn({ status: 'waiting_tools', deadline: 'future', active: true })
      const tool = await makeTool(scope, { status: 'waiting_external', roundPosition: 1, toolName: 'media_failure' })
      const failedJob = await makeJob('failed')
      await makeLink(scope, tool.toolId, failedJob.jobId, 0)

      const outcome = await mediaRecovery.reconcileMediaJobs(10)
      assert.deepEqual(outcome, { kind: 'media', processed: 1, remaining: false })

      const failed = await one<{ status: string; result: Row | null; error: Row }>(
        'SELECT status,result,error FROM agent_tool_calls WHERE id=$1', [tool.toolId])
      assert.equal(failed.status, 'failed')
      assert.equal(failed.result, null)
      assert.equal(failed.error.code, 'TOOL_FAILED')

      const turn = await one<{ status: string; revision: string }>('SELECT status,revision::text FROM agent_turns WHERE id=$1', [scope.turnId])
      assert.equal(turn.status, 'queued')
      assert.equal(turn.revision, '3')
      assert.equal((await sessionState(scope)).active_turn_id, scope.turnId)
    })

    await t.test('outboxBacklog reports pending, quarantine and a finite oldest age', async () => {
      await tx(async c => {
        await c.query('DELETE FROM outbox_events')
        await c.query(`INSERT INTO outbox_events(event_type,aggregate_id,payload,created_at)
          VALUES('fixture.pending',$1,'{}'::jsonb,clock_timestamp()-interval '2 seconds')`, [randomUUID()])
        await c.query(`INSERT INTO outbox_events(event_type,aggregate_id,payload,dispatched_at)
          VALUES('fixture.dispatched',$1,'{}'::jsonb,clock_timestamp())`, [randomUUID()])
        await c.query(`INSERT INTO outbox_events(event_type,aggregate_id,payload,quarantined_at,quarantine_code)
          VALUES('fixture.quarantined',$1,'{}'::jsonb,clock_timestamp(),'fixture')`, [randomUUID()])
      })

      const backlog = await recovery.outboxBacklog()
      assert.equal(backlog.pending, 1)
      assert.equal(backlog.quarantined, 1)
      assert.equal(typeof backlog.oldestAgeMs, 'number')
      assert.ok(Number.isFinite(backlog.oldestAgeMs!))
      assert.ok(backlog.oldestAgeMs! >= 0)
    })
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`) }
    finally { await admin.end() }
  }
})
