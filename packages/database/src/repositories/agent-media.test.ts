import assert from 'node:assert/strict'
import test from 'node:test'
import { appendMediaJobCompleted, assertAgentMediaApproval, linkAgentMediaJob, mediaCompletionDependencies, type AgentMediaSql } from './agent-media'
import { canonicalJsonDigest } from '../canonical-json-digest'

const scope = { ownerId: 'owner', sessionId: 'session', turnId: 'turn' }
function fixture(steps: Array<[RegExp, Record<string, unknown>[]]>) {
  const calls: { sql: string; params: unknown[] }[] = []
  const client: AgentMediaSql = { async query(sql, params = []) {
    calls.push({ sql, params })
    const step = steps.shift()
    assert.ok(step, `unexpected SQL: ${sql}`)
    assert.match(sql.replace(/\s+/g, ' '), step[0])
    const parameters = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]))
    assert.equal(Math.max(0, ...parameters), params.length)
    return { rows: step[1], rowCount: step[1].length }
  } }
  return { client, calls, done() { assert.equal(steps.length, 0) } }
}

test('completion Outbox reads actual terminal timestamp/status on caller SQL, excludes retries, and uses exact cycle dedupe', async () => {
  const f = fixture([[/INSERT INTO outbox_events/, []]])
  await appendMediaJobCompleted(f.client, 'job')
  const { sql, params } = f.calls[0]
  assert.match(sql, /status IN \('succeeded','failed','canceled'\) AND completed_at IS NOT NULL/)
  assert.match(sql, /'completedAt',completed_at::text/)
  assert.match(sql, /'media.job.completed:' \|\| id \|\| ':' \|\| completed_at::text/)
  assert.match(sql, /ON CONFLICT\(dedupe_key\) WHERE dedupe_key IS NOT NULL DO NOTHING/)
  assert.deepEqual(params, ['job'])
  f.done()
})

test('approval enforcement validates durable tool arguments, approval and owned reserved estimate together', async () => {
  const args = { modelRevisionId: 'media-revision', prompt: 'draw' }
  const hash = canonicalJsonDigest(args)
  const f = fixture([
    [/c\.arguments_hash=\$5 AND c.status='executing' FOR UPDATE OF c/, [{ id: 'tool', arguments: args }]],
    [/JOIN agent_budget_reservations b .*a.status='approved'.*clock_timestamp\(\)<a.expires_at.*b.status='reserved'.*FOR UPDATE OF a,b/,
      [{ model_revision: 'language-revision', pricing_revision: 'price', reservation_id: 'reservation', amount: '0.000000000', currency: 'USD' }]],
  ])
  const binding = await assertAgentMediaApproval(f.client, scope, 'tool', 'round', hash)
  assert.equal(binding.modelRevision, 'language-revision')
  assert.equal(binding.reservationId, 'reservation')
  assert.match(f.calls[1].sql, /a.model_revision=t.config_snapshot->>'modelRevisionId'/)
  assert.match(f.calls[1].sql, /s.owner_id=\$5/)
  assert.deepEqual(f.calls[0].params, ['tool', 'turn', 'session', 'round', hash])
  f.done()
})

test('approval missing/rejected/expired or changed durable tool arguments refuses before any effect', async () => {
  const args = { prompt: 'draw' }, hash = canonicalJsonDigest(args)
  for (const approvedTool of [false, true]) {
    const steps: Array<[RegExp, Record<string, unknown>[]]> = [[/SELECT c.id,c.arguments/, [{ id: 'tool', arguments: approvedTool ? args : { prompt: 'different' } }]]]
    if (approvedTool) steps.push([/FROM agent_approvals/, []])
    const f = fixture(steps)
    await assert.rejects(assertAgentMediaApproval(f.client, scope, 'tool', 'round', hash), { code: 'APPROVAL_CONFLICT' })
    assert.ok(f.calls.every(c => c.sql.startsWith('SELECT')))
    f.done()
  }
})

test('link replay requires same job and owner/session/turn; a conflicting position refuses', async () => {
  for (const job of ['job', 'different']) {
    const f = fixture([[/INSERT INTO agent_tool_job_links/, []], [/SELECT media_job_id FROM agent_tool_job_links/, [{ media_job_id: job }]]])
    const effect = linkAgentMediaJob(f.client, scope, 'tool', 'job')
    if (job === 'job') await effect
    else await assert.rejects(effect, { code: 'IDEMPOTENCY_CONFLICT' })
    assert.deepEqual(f.calls[1].params, ['tool', 'session', 'turn', 'owner'])
    f.done()
  }
})

test('completion verifies Outbox/DB identity, owner link, current terminal status and exact retry cycle', async () => {
  const f = fixture([[/SELECT DISTINCT l.owner_id/, []]])
  assert.deepEqual(await mediaCompletionDependencies(f.client, 'event', 'job'), [])
  const sql = f.calls[0].sql
  assert.match(sql, /e.event_type='media.job.completed'/)
  assert.match(sql, /l.owner_id=j.created_by/)
  assert.match(sql, /e.payload->>'completedAt'=j.completed_at::text/)
  assert.match(sql, /e.payload->>'status'=j.status::text/)
  assert.match(sql, /e.payload->>'jobId'=j.id::text/)
  f.done()
})
