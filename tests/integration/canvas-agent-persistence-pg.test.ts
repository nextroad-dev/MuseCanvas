import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import type pg from 'pg'
import { parseCanvasAgentMessageRequest, type CanvasOp, type JsonObject } from '../../packages/contracts/src/index'
import * as repo from '../../packages/database/src/repositories/canvas-agent'
import { PgAgentStore } from '../../apps/api/src/modules/canvases/agent/store'

// REAL PostgreSQL transaction/lock tests, not generation service/outbox/provider evidence.
// Deliberately never read DATABASE_URL or .env. This explicit fixture-only opt-in is
// tied to the supervisor-owned synthetic tunnel, not an arbitrary configured database.
const enabled = process.env.MUSECANVAS_AGENT_PG_TEST === '1'
const skip = enabled ? false : 'Requires explicit synthetic fixture PG opt-in; never uses DATABASE_URL'
const require = createRequire(new URL('../../packages/database/package.json', import.meta.url))

test('real isolated PG: canvas-agent persistence, legacy identity and serialized apply', { skip, timeout: 60_000 }, async t => {
  const url = process.env.MUSECANVAS_AGENT_PG_TEST_URL
  assert.equal(url, 'postgresql://fixture@127.0.0.1:35429/musecanvas_ui', 'Only the owned synthetic tunnel is allowed')
  const fixturePath = process.env.MUSECANVAS_AGENT_PG_FIXTURE_PATH
  assert.ok(fixturePath, 'Explicit synthetic fixture IDs required')
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as { ids: { actor: string; canvas: string; session: string; imageModel: string } }
  const { Pool } = require('pg') as typeof import('pg')
  const pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5000 })
  const scopes: repo.CanvasAgentScope[] = [], jobs: string[] = []
  async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  async function begin(mode: 'agent-managed' | 'client-managed' | 'legacy' = 'agent-managed') {
    return tx(async client => {
      const canvas = (await client.query("INSERT INTO canvas_documents(created_by,title) VALUES($1,'synthetic persistence test') RETURNING id", [fixture.ids.actor])).rows[0]
      const session = await repo.getOrCreateCanvasAgentSession(client, { actorId: fixture.ids.actor, canvasId: canvas.id })
      assert.ok(session)
      const scope = { actorId: fixture.ids.actor, canvasId: canvas.id, sessionId: session.id }
      scopes.push(scope)
      const original: JsonObject = { kind: 'user', messageId: randomUUID(), text: 'synthetic request', baseRevision: 1, requireConfirmation: true }
      const snapshot: JsonObject = { ...original, sceneCommitMode: mode === 'legacy' ? 'client-managed' : mode }
      const claim = await repo.beginCanvasAgentTurn(client, scope, { messageId: String(original.messageId), requestDigest: repo.canvasAgentRequestDigest(mode === 'legacy' ? original : snapshot), requestSnapshot: mode === 'legacy' ? null : snapshot, timeoutMs: 120000 }, { role: 'user', content: String(original.text) })
      assert.equal(claim.status, 'claimed'); if (claim.status !== 'claimed') throw new Error('claim')
      return { scope, original, snapshot, lease: { turnId: claim.turn.id, leaseToken: claim.turn.leaseToken } }
    })
  }
  async function addPending(run: Awaited<ReturnType<typeof begin>>, sourceNodeId?: string) {
    const call = `${run.lease.turnId}:${randomUUID()}`, ids = repo.canvasAgentPendingIdentity(run.scope.canvasId, call)
    const ops: CanvasOp[] = [{ type: 'add_node', node: { id: ids.nodeId, type: 'image', position: { x: 1, y: 2 }, data: { prompt: 'synthetic image', ...(sourceNodeId ? { sourceNodeId } : {}) } } }]
    if (sourceNodeId) ops.push({ type: 'connect', edge: { id: ids.edgeId, source: sourceNodeId, target: ids.nodeId } })
    const normalized: JsonObject = { modelId: fixture.ids.imageModel, prompt: 'synthetic image', parameters: {}, mode: 'text_to_image', inputs: [] }
    const result = await tx(client => repo.createCanvasAgentPendingJob(client, run.scope, run.lease, { toolCallId: call, kind: 'image', prompt: 'synthetic image', modelId: fixture.ids.imageModel, parameters: {}, sourceNodeId: null, sourceAssetId: null, baseRevision: 1, expiresAt: new Date(Date.now() + 86400000).toISOString(), modelConfigDigest: 'd'.repeat(64), ops, requestVersion: 2, normalizedRequest: normalized, normalizedInputs: [] }))
    assert.equal(result.status, 'created'); if (result.status !== 'created') throw new Error('pending')
    return result.pending
  }
  async function submit(scope: repo.CanvasAgentScope, pending: repo.CanvasAgentPendingJob) {
    const claim = await tx(client => repo.claimCanvasAgentPendingJob(client, scope, pending.id, 120000))
    assert.equal(claim.status, 'claimed'); if (claim.status !== 'claimed') throw new Error('pending claim')
    const id = randomUUID(), normalized = repo.canvasAgentGenerationRequest(pending)
    await pool.query(`INSERT INTO generation_jobs(id,created_by,model_id,model_name,adapter,vendor_model_id,size,count,idempotency_key,media_kind,normalized_request,request_digest)
      SELECT $1,$2,m.id,m.display_name,m.adapter,m.vendor_model_id,'1024x1024',1,$3,'image',$4,$5 FROM model_configs m WHERE m.id=$6`,
    [id, scope.actorId, pending.idempotencyKey, JSON.stringify(normalized), repo.canvasAgentRequestDigest(normalized as JsonObject), pending.modelId])
    jobs.push(id)
    const result = await tx(client => repo.completeCanvasAgentPendingJob(client, scope, { pendingId: pending.id, leaseToken: claim.pending.leaseToken!, jobId: id }))
    assert.equal(result.status, 'completed'); if (result.status !== 'completed') throw new Error('attach')
    return result.pending
  }
  const apply = (run: Awaited<ReturnType<typeof begin>>) => tx(client => repo.applyCanvasAgentTurnScene(client, run.scope, { turnId: run.lease.turnId }))
  async function baseline() {
    return {
      turns: (await pool.query('SELECT to_jsonb(t) AS row FROM canvas_agent_turns t WHERE session_id=$1 ORDER BY id', [fixture.ids.session])).rows,
      pending: (await pool.query('SELECT to_jsonb(p) AS row FROM canvas_agent_pending_jobs p WHERE session_id=$1 ORDER BY id', [fixture.ids.session])).rows,
      messages: (await pool.query('SELECT to_jsonb(m) AS row FROM canvas_agent_messages m WHERE session_id=$1 ORDER BY seq', [fixture.ids.session])).rows,
      canvas: (await pool.query('SELECT to_jsonb(c) AS row FROM canvas_documents c WHERE id=$1', [fixture.ids.canvas])).rows,
    }
  }
  let initial: Awaited<ReturnType<typeof baseline>> | undefined, initialOutbox: number | undefined
  try {
    assert.deepEqual((await pool.query('SELECT current_database() AS database,current_user AS actor')).rows[0], { database: 'musecanvas_ui', actor: 'fixture' })
    initial = await baseline(); initialOutbox = Number((await pool.query('SELECT count(*) FROM outbox_events')).rows[0].count)
    await t.test('legacy digest replays exactly without changing null snapshot or original digest, altered request conflicts', async () => {
      const run = await begin('legacy')
      await tx(client => repo.finishCanvasAgentTurn(client, run.scope, run.lease, { role: 'assistant', content: 'legacy answer' }))
      const parsed = parseCanvasAgentMessageRequest(run.original); assert.ok(parsed.success)
      if (!parsed.success) throw new Error('parse')
      const current = parsed.data as unknown as JsonObject
      const replay = await tx(client => repo.claimCanvasAgentTurn(client, run.scope, { messageId: String(run.original.messageId), requestDigest: repo.canvasAgentRequestDigest(current), requestSnapshot: current, timeoutMs: 120000 }))
      assert.equal(replay.status, 'replay')
      for (const patch of [{ text: 'changed' }, { baseRevision: 2 }, { requireConfirmation: false }, { sceneCommitMode: 'agent-managed' }, { context: {} }] as JsonObject[]) {
        const changed = { ...current, ...patch }
        assert.equal((await tx(client => repo.claimCanvasAgentTurn(client, run.scope, { messageId: String(run.original.messageId), requestDigest: repo.canvasAgentRequestDigest(changed), requestSnapshot: changed, timeoutMs: 120000 }))).status, 'conflict')
      }
      const stored = await tx(client => repo.getCanvasAgentTurnById(client, run.scope, run.lease.turnId))
      assert.equal(stored!.requestSnapshot, null); assert.equal(stored!.requestDigest, repo.canvasAgentRequestDigest(run.original))
      assert.equal((await apply(run)).status, 'conflict')
    })
    await t.test('pending AND submitting prevent apply/marker, confirmed submission resolves the gate', async () => {
      const run = await begin(), pending = await addPending(run)
      await tx(client => repo.finishCanvasAgentTurn(client, run.scope, run.lease, { role: 'assistant', content: 'await confirmation' }))
      assert.deepEqual(await apply(run), { status: 'conflict', code: 'CANVAS_AGENT_BUSY' })
      const claim = await tx(client => repo.claimCanvasAgentPendingJob(client, run.scope, pending.id, 1000)); assert.equal(claim.status, 'claimed')
      assert.deepEqual(await apply(run), { status: 'conflict', code: 'CANVAS_AGENT_BUSY' })
      const row = (await pool.query('SELECT scene_commit_revision FROM canvas_agent_turns WHERE id=$1', [run.lease.turnId])).rows[0]
      assert.equal(row.scene_commit_revision, null)
      assert.equal((await pool.query('SELECT revision FROM canvas_documents WHERE id=$1', [run.scope.canvasId])).rows[0].revision, 1)
      // Test-only expired claim; reclaims the SAME pending and key, never resets its snapshot.
      await pool.query("UPDATE canvas_agent_pending_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [pending.id])
      await submit(run.scope, pending)
      assert.equal((await apply(run)).status, 'applied')
    })
    await t.test('two REAL blocked transactions serialize to applied+replay, marker survives a later canvas revision', async () => {
      const run = await begin(), noteId = randomUUID()
      const ops: CanvasOp[] = [{ type: 'add_node', node: { id: noteId, type: 'note', position: { x: 0, y: 0 }, data: { text: 'concurrent' } } }]
      await tx(client => repo.finishCanvasAgentTurn(client, run.scope, run.lease, { role: 'assistant', content: 'complete', ops }))
      const blocker = await pool.connect(), first = await pool.connect(), second = await pool.connect()
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT id FROM canvas_agent_sessions WHERE id=$1 FOR UPDATE', [run.scope.sessionId])
        const pids = [(await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid]
        const execute = async (client: pg.PoolClient) => {
          await client.query('BEGIN')
          try { const result = await repo.applyCanvasAgentTurnScene(client, run.scope, { turnId: run.lease.turnId }); await client.query('COMMIT'); return result }
          catch (error) { await client.query('ROLLBACK'); throw error }
        }
        const pendingResults = [execute(first), execute(second)]
        let blocked = false
        for (let attempt = 0; attempt < 100; attempt++) {
          const count = Number((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'", [pids])).rows[0].count)
          if (count === 2) { blocked = true; break }
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        // Release even on instrumentation failure so no unresolved test transactions leak.
        await blocker.query('COMMIT')
        const results = await Promise.all(pendingResults)
        assert.equal(blocked, true, 'Both actual PostgreSQL backends must wait on locks before release')
        assert.deepEqual(results.map(result => result.status).sort(), ['applied', 'replay'])
        for (const result of results) { assert.ok(result.status === 'applied' || result.status === 'replay'); if (result.status === 'applied' || result.status === 'replay') { assert.equal(result.revision, 2); assert.deepEqual(result.ops, ops) } }
        await pool.query('UPDATE canvas_documents SET revision=revision+1 WHERE id=$1', [run.scope.canvasId])
        assert.deepEqual(await apply(run), { status: 'replay', revision: 2, ops })
      } finally { await blocker.query('ROLLBACK'); blocker.release(); first.release(); second.release() }
    })
    for (const status of ['canceled', 'failed', 'expired'] as const) await t.test(`${status} recovers submitted media + necessary dependency, not unconfirmed or unrelated suggestions`, async () => {
      const run = await begin(), sourceId = randomUUID(), unrelatedId = randomUUID()
      const pending = await addPending(run, sourceId), unresolved = await addPending(run)
      const ops: CanvasOp[] = [
        { type: 'add_node', node: { id: sourceId, type: 'note', position: { x: 0, y: 0 }, data: { text: 'necessary source' } } },
        { type: 'add_node', node: { id: unrelatedId, type: 'note', position: { x: 0, y: 0 }, data: { text: 'unfinished suggestion' } } },
        { type: 'arrange', positions: [{ nodeId: sourceId, position: { x: 90, y: 80 } }] },
      ]
      await tx(client => repo.appendCanvasAgentMessage(client, run.scope, { role: 'tool', content: 'partial work', ops }, run.lease))
      const submitted = await submit(run.scope, pending)
      await tx(client => repo.releaseCanvasAgentTurn(client, run.scope, run.lease, status))
      assert.deepEqual(await apply(run), { status: 'conflict', code: 'CANVAS_AGENT_BUSY' })
      assert.equal((await tx(client => repo.rejectCanvasAgentPendingJob(client, run.scope, unresolved.id))).status, 'rejected')
      const applied = await apply(run); assert.equal(applied.status, 'applied')
      if (applied.status !== 'applied') throw new Error('apply')
      assert.deepEqual(applied.ops.map(op => op.type), ['add_node', 'add_node', 'connect'])
      assert.ok(JSON.stringify(applied.ops).includes(submitted.jobId!)); assert.ok(!JSON.stringify(applied.ops).includes(unrelatedId))
      const scene = (await pool.query('SELECT scene FROM canvas_documents WHERE id=$1', [run.scope.canvasId])).rows[0].scene
      assert.deepEqual(scene.nodes.map((node: { id: string }) => node.id).sort(), [sourceId, pending.nodeId].sort())
      assert.deepEqual(scene.nodes.find((node: { id: string }) => node.id === sourceId).position, { x: 0, y: 0 })
      assert.deepEqual(await apply(run), { ...applied, status: 'replay' })
      const store = new PgAgentStore(tx)
      const recovery = await store.turn(run.scope.actorId, run.scope.canvasId, run.lease.turnId)
      assert.equal(recovery.status, status); assert.equal(recovery.requestSnapshot!.baseRevision, 1); assert.equal(recovery.sceneCommitRevision, 2)
      assert.equal(recovery.pendingJobs.length, 2); assert.ok(!('leaseToken' in recovery))
      await assert.rejects(store.turn(randomUUID(), run.scope.canvasId, run.lease.turnId))
    })
    await t.test('client-managed stays suggestion-only and owner/deleted scopes cannot apply/recover', async () => {
      const run = await begin('client-managed')
      await tx(client => repo.finishCanvasAgentTurn(client, run.scope, run.lease, { role: 'assistant', content: 'client suggestion' }))
      assert.deepEqual(await apply(run), { status: 'conflict', code: 'CANVAS_AGENT_APPLY_CONFLICT' })
      assert.deepEqual(await tx(client => repo.applyCanvasAgentTurnScene(client, { ...run.scope, actorId: randomUUID() }, { turnId: run.lease.turnId })), { status: 'not_found' })
      await pool.query('UPDATE canvas_documents SET deleted_at=now() WHERE id=$1', [run.scope.canvasId])
      assert.deepEqual(await apply(run), { status: 'not_found' })
      await assert.rejects(new PgAgentStore(tx).turn(run.scope.actorId, run.scope.canvasId, run.lease.turnId))
    })
    assert.deepEqual(await baseline(), initial, 'Pre-existing synthetic v1/v2 fixtures preserved byte-for-JSON')
    assert.equal(Number((await pool.query('SELECT count(*) FROM outbox_events')).rows[0].count), initialOutbox, 'No dispatch/outbox creation')
  } finally {
    // Delete only IDs this test created; never touch baseline fixtures, users/models/assets.
    for (const scope of scopes) await tx(async client => {
      await client.query('DELETE FROM canvas_agent_pending_jobs WHERE session_id=$1', [scope.sessionId])
      await client.query('DELETE FROM canvas_agent_messages WHERE session_id=$1', [scope.sessionId])
      await client.query('DELETE FROM canvas_agent_turns WHERE session_id=$1', [scope.sessionId])
      await client.query('DELETE FROM canvas_agent_sessions WHERE id=$1', [scope.sessionId])
      await client.query('DELETE FROM canvas_documents WHERE id=$1', [scope.canvasId])
    })
    for (const id of jobs) await pool.query('DELETE FROM generation_jobs WHERE id=$1', [id])
    await pool.end()
  }
})
