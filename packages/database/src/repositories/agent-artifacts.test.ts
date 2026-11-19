import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { canonicalJsonDigest } from '../canonical-json-digest'
import { AgentCoreError, type AgentCoreClient, type AgentCoreTransaction } from './agent-core'
import { AgentArtifactsRepository, agentArtifactDTO } from './agent-artifacts'
import { agentArtifactProjection } from './agent-artifact-projection'
import { AGENT_ARTIFACT_MAX_MESSAGES, artifactIdentity, artifactPageQuery, artifactReplyInput, artifactResolveInput, artifactThreadInput, decodeArtifactCursor, encodeArtifactCursor, validateArtifactAnchor } from './agent-artifact-validation'

const owner = '10000000-0000-4000-8000-000000000001'
const sid = '20000000-0000-4000-8000-000000000001'
const tid = '30000000-0000-4000-8000-000000000001'
const iid = '40000000-0000-4000-8000-000000000001'
const asset = '50000000-0000-4000-8000-000000000001'
const requestId = '60000000-0000-4000-8000-000000000001'
const aid = `text:${iid}`
const mediaId = `media:${asset}`
const now = new Date('2026-11-19T11:00:00.123Z')
const textRow = { artifact_id: aid, session_id: sid, turn_id: tid, source_item_id: iid, source_sequence: '9007199254740993', source_created_at: now, kind: 'text', content: 'A😀 B', available: true }
const mediaRow = { ...textRow, artifact_id: mediaId, kind: 'video', asset_id: asset, content: null, width: 720, height: 1280, duration_ms: '1250', available: false }
const thread = { id: tid, ordinal: '9007199254740993', session_id: sid, owner_id: owner, artifact_id: aid, version: 1, anchor: { kind: 'whole' }, resolved: false, resolved_at: null, created_at: now }
const message = { id: iid, body: 'private comment', created_at: now }
const create = { clientRequestId: requestId, version: 1 as const, anchor: { kind: 'whole' as const }, body: message.body }
type Step = [RegExp, Record<string, unknown>[]]
function fixture(steps: Step[]) {
  const calls: { sql: string; args: unknown[] }[] = [], modes: boolean[] = []
  const client = { async query(sql: string, args: unknown[] = []) {
    calls.push({ sql, args })
    const step = steps.shift(); assert.ok(step, `unexpected SQL: ${sql}`)
    assert.match(sql.replace(/\s+/g, ' '), step[0])
    const indices = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]))
    assert.equal(indices.length ? Math.max(...indices) : 0, args.length, 'bind count only; not PostgreSQL execution')
    return { rows: step[1] }
  } } as unknown as AgentCoreClient
  const tx: AgentCoreTransaction = async (work, readOnly = false) => { modes.push(readOnly); return work(client) }
  return { repo: new AgentArtifactsRepository(tx), calls, modes, done() { assert.equal(steps.length, 0) } }
}
const actor: Step = [/FROM users .*status='active'.*deleted_at IS NULL FOR NO KEY UPDATE/, [{ id: owner }]]
const scope: Step = [/FROM agent_sessions s JOIN users u .*s.owner_id=\$1 AND s.id=\$2.*u.status='active'.*u.deleted_at IS NULL/, [{ id: sid }]]
const artifact = (row = textRow): Step => [/SELECT \* FROM artifacts WHERE artifact_id=\$3$/, [row]]
const lookup: Step = [/FROM agent_artifact_threads WHERE owner_id=\$1 AND session_id=\$2 AND artifact_id=\$3 AND id=\$4/, [thread]]
const messages: Step = [/FROM agent_artifact_messages WHERE thread_id=\$1 ORDER BY ordinal LIMIT \$2/, [message]]
const missingReceipt: Step = [/FROM agent_artifact_requests WHERE owner_id=\$1 AND client_request_id=\$2/, []]

test('agent-artifacts: DTO projection exposes only safe IDs, content and metadata with ISO dates', () => {
  const dto = agentArtifactDTO({ ...mediaRow, object_key: 'secret/key', signed_url: 'https://secret.invalid', metadata: { private: 'hidden' }, duration_ms: 'NaN' })
  assert.deepEqual(dto, { id: mediaId, sessionId: sid, turnId: tid, sourceItemId: iid, version: 1, createdAt: now.toISOString(), kind: 'video', assetId: asset, available: false, width: 720, height: 1280, durationMs: null })
  assert.equal(agentArtifactDTO({ ...mediaRow, width: -1 }).kind, 'video')
  assert.equal(JSON.stringify(dto).includes('secret'), false)
})
test('agent-artifacts: static projection requires committed result, owner/session/turn/tool/job/output provenance', () => {
  const sql = agentArtifactProjection.replace(/\s+/g, ' ')
  for (const clause of [
    "i.item_type='assistant_message'", "jsonb_typeof(i.payload->'content')='string'", "i.payload->>'content' ~ '[^[:space:]]'",
    's.owner_id=$1', 't.id=i.turn_id AND t.session_id=i.session_id', 'c.id=i.tool_call_id AND c.turn_id=i.turn_id AND c.session_id=i.session_id',
    'l.tool_call_id=c.id AND l.turn_id=c.turn_id AND l.session_id=c.session_id AND l.owner_id=s.owner_id',
    'j.id=l.media_job_id AND j.created_by=l.owner_id', 'o.job_id=j.id', 'a.id=o.asset_id AND a.job_id=j.id AND a.created_by=s.owner_id',
    "i.item_type='tool_result'", "l.dependency_role='output'", "i.payload->>'status'=c.status", "i.payload->'result'=c.result", "j.status='succeeded' AND j.completed_at IS NOT NULL",
  ]) assert.ok(sql.includes(clause), clause)
  assert.doesNotMatch(sql, /object_key|poster_|url|c\.arguments|artifact_reference/)
})
test('agent-artifacts: static normal/recovery shapes exclude pending/failed-only results but preserve successful portions', () => {
  const sql = agentArtifactProjection.replace(/\s+/g, ' ')
  assert.match(sql, /c.status IN \('completed','failed','cancelled'\)/)
  assert.match(sql, /r.job->>'jobId'=j.id::text AND r.job->>'status'='succeeded'/)
  assert.match(sql, /r.job->'assetIds'\) @> jsonb_build_array\(a.id::text\)/)
  assert.match(sql, /OR \(c.status='completed'.*result'->'assetIds'.*result'->'jobIds'/)
  assert.match(sql, /jsonb_typeof\(i.payload->'result'->'jobs'\)='array'/)
  assert.doesNotMatch(sql, /c.status='completed' AND i.payload/)
})
test('agent-artifacts: static proposal/repeated-output dedupe uses first proven occurrence before pagination and keeps soft deletions', () => {
  assert.match(agentArtifactProjection, /row_number\(\) OVER \(PARTITION BY a.id ORDER BY i.sequence,i.id\)/)
  assert.match(agentArtifactProjection, /FROM media_candidates WHERE occurrence=1/)
  assert.match(agentArtifactProjection, /\(a.deleted_at IS NULL AND j.deleted_at IS NULL\) AS available/)
  assert.match(agentArtifactProjection, /COALESCE\(l.available,false\)/)
  assert.match(agentArtifactProjection, /FROM agent_artifact_snapshots p LEFT JOIN live_artifacts l/)
  assert.doesNotMatch(agentArtifactProjection, /WHERE a.deleted_at IS NULL|AND j.deleted_at IS NULL\s+AND/)
})
test('agent-artifacts: migration is additive, snapshots have no asset/job/item FK and annotation identities are immutable', () => {
  const sql = readFileSync(new URL('../../migrations/0047_agent_artifact_threads.sql', import.meta.url), 'utf8')
  assert.doesNotMatch(sql, /REFERENCES (assets|generation_jobs|agent_items)|INSERT INTO agent_items|ALTER TABLE (assets|generation_jobs|agent_items)|DROP TABLE/)
  assert.match(sql, /CHECK\(version = 1\)/)
  assert.match(sql, /PRIMARY KEY\(owner_id,client_request_id\)/)
  assert.match(sql, /to_jsonb\(NEW\) - ARRAY\['resolved','resolved_at'\]/)
  assert.match(sql, /ON agent_artifact_messages/)
})
test('agent-artifacts: wrong owner/session is generic NOT_FOUND before any media or thread lookup', async () => {
  const f = fixture([[scope[0], []]])
  await assert.rejects(f.repo.detail(owner, sid, mediaId), { code: 'NOT_FOUND' }); f.done()
  assert.equal(f.calls.length, 1); assert.deepEqual(f.modes, [true])
})
test('agent-artifacts: mutation actor status and ownership serialize before receipts/projection', async () => {
  const f = fixture([[actor[0], []]])
  await assert.rejects(f.repo.createThread(owner, sid, aid, create), { code: 'NOT_FOUND' }); f.done()
  const g = fixture([actor, [scope[0], []]])
  await assert.rejects(g.repo.createThread(owner, sid, aid, create), { code: 'NOT_FOUND' }); g.done()
  assert.match(g.calls[1]!.sql, /FOR UPDATE OF s$/)
})
test('agent-artifacts: stable descending artifact keyset uses exact bigint and identity tie break', async () => {
  const f = fixture([scope, [/ORDER BY source_sequence DESC,artifact_id COLLATE "C" DESC LIMIT \$5/, [textRow, { ...mediaRow, source_sequence: '9007199254740992' }]]])
  const page = await f.repo.list(owner, sid, 1)
  assert.equal(page.items.length, 1); assert.ok(page.nextCursor)
  assert.equal(decodeArtifactCursor(page.nextCursor, 'artifacts', sid)!.sequence, '9007199254740993'); f.done()
  const g = fixture([scope, [/\(source_sequence,artifact_id COLLATE "C"\) < \(\$3::bigint,\$4::text COLLATE "C"\)/, []]])
  assert.deepEqual(await g.repo.list(owner, sid, 1, page.nextCursor), { items: [], nextCursor: null })
  assert.deepEqual(g.calls[1]!.args.slice(2), ['9007199254740993', aid, 2]); g.done()
})
test('agent-artifacts: thread cursor is independent, scoped and uses descending insertion ordinal', async () => {
  const f = fixture([scope, artifact(), [/FROM agent_artifact_threads.*ORDER BY ordinal DESC LIMIT \$5/, [thread, { ...thread, id: iid, ordinal: '2' }]], messages])
  const page = await f.repo.threads(owner, sid, aid, 1)
  assert.ok(page.nextCursor); assert.equal(decodeArtifactCursor(page.nextCursor, 'threads', sid, aid)!.sequence, String(thread.ordinal)); f.done()
  assert.throws(() => decodeArtifactCursor(page.nextCursor!, 'artifacts', sid), AgentCoreError)
  assert.throws(() => decodeArtifactCursor(page.nextCursor!, 'threads', owner, aid), AgentCoreError)
  assert.throws(() => decodeArtifactCursor(page.nextCursor!, 'threads', sid, mediaId), AgentCoreError)
})
test('agent-artifacts: rejects malformed/oversized/foreign cursors and strict page query', () => {
  for (const value of ['', 'a'.repeat(513), '@@', 'e30', Buffer.from('{bad').toString('base64url')]) assert.throws(() => decodeArtifactCursor(value, 'artifacts', sid), AgentCoreError)
  for (const sequence of ['0', '01', '9223372036854775808']) assert.throws(() => decodeArtifactCursor(encodeArtifactCursor({ kind: 'artifacts', sessionId: sid, sequence, id: aid }), 'artifacts', sid), AgentCoreError)
  for (const query of ['?limit=0', '?limit=101', '?limit=01', '?limit=1&limit=2', '?extra=1', '?cursor=', '?cursor=' + 'a'.repeat(1025)]) assert.throws(() => artifactPageQuery(new URL(`https://example.invalid/${query}`)), AgentCoreError)
  assert.deepEqual(artifactPageQuery(new URL('https://example.invalid')), { limit: 50, cursor: undefined })
})
test('agent-artifacts: first thread snapshots explicit safe metadata and stores no Agent item/event/context', async () => {
  const f = fixture([actor, scope, missingReceipt, artifact(), [/INSERT INTO agent_artifact_snapshots/, []], [/INSERT INTO agent_artifact_threads/, [thread]], [/INSERT INTO agent_artifact_messages/, []], [/INSERT INTO agent_artifact_requests/, []], messages])
  const dto = await f.repo.createThread(owner, sid, aid, create)
  assert.deepEqual(dto.messages, [{ id: iid, body: message.body, createdAt: now.toISOString() }]); f.done()
  assert.equal(dto.version, 1); assert.equal(dto.createdAt, now.toISOString())
  assert.deepEqual(f.calls.find(x => x.sql.includes('INSERT INTO agent_artifact_snapshots'))!.args, [sid, owner, aid, tid, iid, textRow.source_sequence, now.toISOString(), 'text', textRow.content, null, null, null, null])
  assert.doesNotMatch(f.calls.map(x => x.sql).join(' '), /INSERT INTO (agent_items|agent_session_events)|UPDATE agent_sessions/)
})
test('agent-artifacts: exact request replay returns the existing thread before looking up mutable media provenance', async () => {
  const hash = canonicalJsonDigest({ operation: 'create', sessionId: sid, artifactId: aid, version: 1, anchor: create.anchor, body: create.body })
  const f = fixture([actor, scope, [/FROM agent_artifact_requests/, [{ request_digest: hash, thread_id: tid }]], lookup, messages])
  assert.equal((await f.repo.createThread(owner, sid, aid, create)).id, tid); f.done()
  assert.doesNotMatch(f.calls.map(x => x.sql).join(' '), /INSERT INTO|FROM artifacts/)
})
test('agent-artifacts: owner-global request UUID conflicting body/operation/scope cannot be reused', async () => {
  for (const change of [{ ...create, body: 'changed' }, create]) {
    const f = fixture([actor, scope, [/FROM agent_artifact_requests/, [{ request_digest: 'a'.repeat(64), thread_id: tid }]]])
    await assert.rejects(f.repo.createThread(owner, sid, aid, change), { code: 'CONFLICT' }); f.done()
  }
})
test('agent-artifacts: text anchors count UTF-16 code units with exact quote and reject surrogate splits', () => {
  const artifact = agentArtifactDTO(textRow)
  assert.deepEqual(validateArtifactAnchor(artifact, { kind: 'text', start: 1, end: 3, quote: '😀' }), { kind: 'text', start: 1, end: 3, quote: '😀' })
  assert.equal(validateArtifactAnchor(artifact, { kind: 'text', start: 3, end: 4, quote: ' ' }).kind, 'text')
  for (const anchor of [{ kind: 'text', start: 1, end: 2, quote: '\uD83D' }, { kind: 'text', start: 1, end: 3, quote: 'XX' }, { kind: 'text', start: 0, end: 99, quote: 'x' }, { kind: 'text', start: 1.5, end: 3, quote: 'x' }, { kind: 'text', start: 0, end: 0, quote: '' }]) assert.throws(() => validateArtifactAnchor(artifact, anchor), AgentCoreError)
})
test('agent-artifacts: image coordinates and rectangles are finite normalized and match the artifact kind', () => {
  const image = agentArtifactDTO({ ...mediaRow, kind: 'image' })
  for (const anchor of [{ kind: 'image_point', x: 0, y: 1 }, { kind: 'image_rect', x: 0.1, y: 0.2, width: 0.4, height: 0.5 }]) assert.doesNotThrow(() => validateArtifactAnchor(image, anchor))
  for (const anchor of [{ kind: 'image_point', x: NaN, y: 0 }, { kind: 'image_point', x: Infinity, y: 0 }, { kind: 'image_rect', x: 0.9, y: 0, width: 0.2, height: 1 }, { kind: 'image_rect', x: 0, y: 0, width: 0, height: 1 }]) assert.throws(() => validateArtifactAnchor(image, anchor), AgentCoreError)
  assert.throws(() => validateArtifactAnchor(agentArtifactDTO(textRow), { kind: 'image_point', x: 0, y: 0 }), AgentCoreError)
})
test('agent-artifacts: video anchors require actual known duration and integer milliseconds within it', () => {
  const video = agentArtifactDTO(mediaRow)
  for (const timeMs of [0, 1250]) assert.doesNotThrow(() => validateArtifactAnchor(video, { kind: 'video', timeMs }))
  for (const timeMs of [-1, 0.5, 1251, Infinity]) assert.throws(() => validateArtifactAnchor(video, { kind: 'video', timeMs }), AgentCoreError)
  assert.throws(() => validateArtifactAnchor(agentArtifactDTO({ ...mediaRow, duration_ms: null }), { kind: 'video', timeMs: 0 }), AgentCoreError)
  assert.equal(validateArtifactAnchor(agentArtifactDTO({ ...mediaRow, duration_ms: null }), { kind: 'whole' }).kind, 'whole')
  assert.throws(() => validateArtifactAnchor(agentArtifactDTO({ ...mediaRow, kind: 'image' }), { kind: 'video', timeMs: 0 }), AgentCoreError)
})
test('agent-artifacts: bad scope or anchor fails before snapshot/thread writes', async () => {
  const f = fixture([actor, scope, missingReceipt, artifact()])
  await assert.rejects(f.repo.createThread(owner, sid, aid, { ...create, anchor: { kind: 'video', timeMs: 0 } }), { code: 'INVALID_INPUT' }); f.done()
  const g = fixture([scope, [lookup[0], []]])
  await assert.rejects(g.repo.thread(owner, sid, mediaId, tid), { code: 'NOT_FOUND' }); g.done()
})
test('agent-artifacts: threads remain readable and replyable from their scope when live media provenance is gone', async () => {
  const saved = { ...thread, artifact_id: mediaId }
  const f = fixture([scope, [/FROM agent_artifact_threads WHERE owner_id=/, [saved]], messages])
  assert.equal((await f.repo.thread(owner, sid, mediaId, tid)).artifactId, mediaId); f.done()
  const g = fixture([actor, scope, [/FROM agent_artifact_threads WHERE owner_id=/, [saved]], missingReceipt, [/count\(\*\)::integer/, [{ count: 1 }]], [/INSERT INTO agent_artifact_messages/, []], [/INSERT INTO agent_artifact_requests/, []], messages])
  assert.equal((await g.repo.reply(owner, sid, mediaId, tid, { clientRequestId: requestId, body: 'reply' })).artifactId, mediaId); g.done()
  assert.doesNotMatch(g.calls.map(x => x.sql).join(' '), /FROM assets|FROM artifacts/)
})
test('agent-artifacts: cap includes first message and exact reply replay bypasses cap without a duplicate', async () => {
  const f = fixture([actor, scope, lookup, missingReceipt, [/count\(\*\)::integer/, [{ count: AGENT_ARTIFACT_MAX_MESSAGES }]]])
  await assert.rejects(f.repo.reply(owner, sid, aid, tid, { clientRequestId: requestId, body: 'reply' }), { code: 'CONFLICT' }); f.done()
  const hash = canonicalJsonDigest({ operation: 'reply', sessionId: sid, artifactId: aid, threadId: tid, body: 'reply' })
  const g = fixture([actor, scope, lookup, [/FROM agent_artifact_requests/, [{ request_digest: hash, thread_id: tid }]], messages])
  assert.equal((await g.repo.reply(owner, sid, aid, tid, { clientRequestId: requestId, body: 'reply' })).id, tid); g.done()
  assert.doesNotMatch(g.calls.map(x => x.sql).join(' '), /INSERT INTO|count\(/)
})
test('agent-artifacts: resolve is idempotent and reopen clears timestamp; both use owner+session+artifact+thread scope', async () => {
  for (const resolved of [true, false]) {
    const row = { ...thread, resolved, resolved_at: resolved ? now : null }
    const f = fixture([actor, scope, lookup, [/UPDATE agent_artifact_threads SET resolved=\$5,.*COALESCE\(resolved_at,clock_timestamp\(\)\).*ELSE NULL.*owner_id=\$1 AND session_id=\$2 AND artifact_id=\$3 AND id=\$4 RETURNING/, [row]], messages])
    const dto = await f.repo.resolve(owner, sid, aid, tid, { resolved }); f.done()
    assert.equal(dto.resolved, resolved); assert.equal(dto.resolvedAt, resolved ? now.toISOString() : null)
    assert.deepEqual(f.calls[3]!.args, [owner, sid, aid, tid, resolved])
  }
})
test('agent-artifacts: UUID/version/body/anchor parsers reject extra data and conflicting payload identity', () => {
  for (const value of [{ ...create, version: 2 }, { ...create, clientRequestId: 'free-string' }, { ...create, body: ' ' }, { ...create, body: 'x'.repeat(8001) }, { ...create, body: '\0' }, { ...create, body: '\uD800' }, { ...create, share: true }, { ...create, anchor: { kind: 'whole', x: 0 } }]) assert.throws(() => artifactThreadInput(value), AgentCoreError)
  assert.equal(artifactThreadInput({ ...create, body: '你'.repeat(2666) + 'ab' }).body.length, 2668)
  assert.throws(() => artifactReplyInput({ clientRequestId: requestId, body: '你'.repeat(2667) }), AgentCoreError)
  assert.throws(() => artifactResolveInput({ resolved: 'true' }), AgentCoreError)
  assert.throws(() => artifactResolveInput({ resolved: true, ownerId: owner }), AgentCoreError)
  assert.equal(artifactIdentity(aid.toUpperCase()), aid)
  for (const value of [iid, `text:${iid}:extra`, 'media:../../assets', `text:${iid}%00`]) assert.throws(() => artifactIdentity(value), AgentCoreError)
})
