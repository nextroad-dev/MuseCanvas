import type {
  AgentArtifactDTO, AgentArtifactPageDTO, AgentArtifactThreadDTO, AgentArtifactThreadsPageDTO,
  CreateAgentArtifactReplyRequest, CreateAgentArtifactThreadRequest, JsonValue, ResolveAgentArtifactThreadRequest,
} from '@musecanvas/contracts'
import { canonicalJsonDigest } from '../canonical-json-digest'
import { AgentCoreError, type AgentCoreClient, type AgentCoreTransaction } from './agent-core'
import { agentArtifactProjection } from './agent-artifact-projection'
import {
  AGENT_ARTIFACT_MAX_MESSAGES, artifactAnchor, artifactIdentity, artifactReplyInput, artifactResolveInput, artifactThreadInput,
  artifactUuid, decodeArtifactCursor, encodeArtifactCursor, validateArtifactAnchor,
} from './agent-artifact-validation'

// Storage rows are never returned: all public fields are explicitly projected below.
type Row = Record<string, unknown>
const required = (row: Row | undefined): Row => { if (!row) throw new AgentCoreError('NOT_FOUND'); return row }
const iso = (value: unknown): string => new Date(value as string | Date).toISOString()
const positive = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
const duration = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}
export function agentArtifactDTO(row: Row): AgentArtifactDTO {
  const base = { sessionId: String(row.session_id), turnId: String(row.turn_id), sourceItemId: String(row.source_item_id), version: 1 as const, createdAt: iso(row.source_created_at) }
  if (row.kind === 'text') return { ...base, id: artifactIdentity(row.artifact_id) as `text:${string}`, kind: 'text', content: String(row.content) }
  if (row.kind !== 'image' && row.kind !== 'video') throw new AgentCoreError('UNAVAILABLE')
  return { ...base, id: artifactIdentity(row.artifact_id) as `media:${string}`, kind: row.kind, assetId: String(row.asset_id),
    available: row.available === true, width: positive(row.width), height: positive(row.height), durationMs: duration(row.duration_ms) }
}
async function one(c: AgentCoreClient, sql: string, args: unknown[]): Promise<Row | undefined> { return (await c.query(sql, args)).rows[0] }
async function scope(c: AgentCoreClient, owner: string, sid: string, write = false) {
  // Match the Agent mutation lock order and recheck status under the actor lock.
  if (write) required(await one(c, `SELECT id FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL FOR NO KEY UPDATE`, [owner]))
  required(await one(c, `SELECT s.id FROM agent_sessions s JOIN users u ON u.id=s.owner_id
    WHERE s.owner_id=$1 AND s.id=$2 AND u.status='active' AND u.deleted_at IS NULL${write ? ' FOR UPDATE OF s' : ''}`, [owner, sid]))
}
function bound(limit: number) { if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AgentCoreError('INVALID_INPUT') }
async function artifactRow(c: AgentCoreClient, owner: string, sid: string, aid: string): Promise<Row> {
  return required(await one(c, `${agentArtifactProjection} SELECT * FROM artifacts WHERE artifact_id=$3`, [owner, sid, aid]))
}
async function threadRow(c: AgentCoreClient, owner: string, sid: string, aid: string, tid: string): Promise<Row> {
  return required(await one(c, `SELECT * FROM agent_artifact_threads WHERE owner_id=$1 AND session_id=$2 AND artifact_id=$3 AND id=$4`, [owner, sid, aid, tid]))
}
async function threadDTO(c: AgentCoreClient, row: Row): Promise<AgentArtifactThreadDTO> {
  const messages = (await c.query(`SELECT id,body,created_at FROM agent_artifact_messages WHERE thread_id=$1 ORDER BY ordinal LIMIT $2`, [row.id, AGENT_ARTIFACT_MAX_MESSAGES])).rows
  return { id: String(row.id), artifactId: artifactIdentity(row.artifact_id), version: 1, anchor: artifactAnchor(row.anchor),
    resolved: row.resolved === true, resolvedAt: row.resolved_at == null ? null : iso(row.resolved_at), createdAt: iso(row.created_at),
    messages: messages.map(message => ({ id: String(message.id), body: String(message.body), createdAt: iso(message.created_at) })) }
}
function digest(value: object) { return canonicalJsonDigest(value as JsonValue) }
async function receipt(c: AgentCoreClient, owner: string, key: string, hash: string): Promise<string | undefined> {
  const row = await one(c, `SELECT request_digest,thread_id FROM agent_artifact_requests WHERE owner_id=$1 AND client_request_id=$2`, [owner, key])
  if (!row) return undefined
  if (row.request_digest !== hash) throw new AgentCoreError('CONFLICT')
  return String(row.thread_id)
}
async function saveReceipt(c: AgentCoreClient, owner: string, key: string, hash: string, threadId: unknown) {
  await c.query(`INSERT INTO agent_artifact_requests(owner_id,client_request_id,request_digest,thread_id) VALUES($1,$2,$3,$4)`, [owner, key, hash, threadId])
}
async function saveSnapshot(c: AgentCoreClient, owner: string, row: Row) {
  const dto = agentArtifactDTO(row)
  await c.query(`INSERT INTO agent_artifact_snapshots(session_id,owner_id,artifact_id,turn_id,source_item_id,source_sequence,source_created_at,kind,content,asset_id,width,height,duration_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(session_id,artifact_id) DO NOTHING`,
  [dto.sessionId, owner, dto.id, dto.turnId, dto.sourceItemId, row.source_sequence, dto.createdAt, dto.kind,
    dto.kind === 'text' ? dto.content : null, dto.kind === 'text' ? null : dto.assetId,
    dto.kind === 'text' ? null : dto.width, dto.kind === 'text' ? null : dto.height, dto.kind === 'text' ? null : dto.durationMs])
}
/** Owner-only annotations never append Agent items, events, or model context. */
export class AgentArtifactsRepository {
  constructor(private readonly tx: AgentCoreTransaction) {}
  list(owner: string, sessionId: string, limit = 50, cursor?: string): Promise<AgentArtifactPageDTO> {
    const sid = artifactUuid(sessionId); artifactUuid(owner); bound(limit)
    const after = decodeArtifactCursor(cursor, 'artifacts', sid)
    return this.tx(async c => {
      await scope(c, owner, sid)
      const rows = (await c.query(`${agentArtifactProjection} SELECT * FROM artifacts
        WHERE ($3::bigint IS NULL OR (source_sequence,artifact_id COLLATE "C") < ($3::bigint,$4::text COLLATE "C"))
        ORDER BY source_sequence DESC,artifact_id COLLATE "C" DESC LIMIT $5`, [owner, sid, after?.sequence ?? null, after?.id ?? null, limit + 1])).rows
      const page = rows.slice(0, limit), last = page.at(-1)
      return { items: page.map(agentArtifactDTO), nextCursor: rows.length > limit && last ? encodeArtifactCursor({ kind: 'artifacts', sessionId: sid, sequence: String(last.source_sequence), id: String(last.artifact_id) }) : null }
    }, true)
  }
  detail(owner: string, sessionId: string, artifactId: string): Promise<AgentArtifactDTO> {
    const sid = artifactUuid(sessionId), aid = artifactIdentity(artifactId); artifactUuid(owner)
    return this.tx(async c => { await scope(c, owner, sid); return agentArtifactDTO(await artifactRow(c, owner, sid, aid)) }, true)
  }
  threads(owner: string, sessionId: string, artifactId: string, limit = 50, cursor?: string): Promise<AgentArtifactThreadsPageDTO> {
    const sid = artifactUuid(sessionId), aid = artifactIdentity(artifactId); artifactUuid(owner); bound(limit)
    const after = decodeArtifactCursor(cursor, 'threads', sid, aid)
    return this.tx(async c => {
      await scope(c, owner, sid); await artifactRow(c, owner, sid, aid)
      const rows = (await c.query(`SELECT * FROM agent_artifact_threads WHERE owner_id=$1 AND session_id=$2 AND artifact_id=$3
        AND ($4::bigint IS NULL OR ordinal<$4::bigint) ORDER BY ordinal DESC LIMIT $5`, [owner, sid, aid, after?.sequence ?? null, limit + 1])).rows
      const page = rows.slice(0, limit), last = page.at(-1)
      const items: AgentArtifactThreadDTO[] = []
      for (const row of page) items.push(await threadDTO(c, row))
      return { items, nextCursor: rows.length > limit && last ? encodeArtifactCursor({ kind: 'threads', sessionId: sid, artifactId: aid, sequence: String(last.ordinal), id: String(last.id) }) : null }
    }, true)
  }
  thread(owner: string, sessionId: string, artifactId: string, threadId: string): Promise<AgentArtifactThreadDTO> {
    const sid = artifactUuid(sessionId), aid = artifactIdentity(artifactId), tid = artifactUuid(threadId); artifactUuid(owner)
    return this.tx(async c => { await scope(c, owner, sid); return threadDTO(c, await threadRow(c, owner, sid, aid, tid)) }, true)
  }
  createThread(owner: string, sessionId: string, artifactId: string, request: CreateAgentArtifactThreadRequest): Promise<AgentArtifactThreadDTO> {
    const sid = artifactUuid(sessionId), aid = artifactIdentity(artifactId), input = artifactThreadInput(request); artifactUuid(owner)
    const hash = digest({ operation: 'create', sessionId: sid, artifactId: aid, version: input.version, anchor: input.anchor, body: input.body })
    return this.tx(async c => {
      await scope(c, owner, sid, true)
      const replay = await receipt(c, owner, input.clientRequestId, hash)
      if (replay) return threadDTO(c, await threadRow(c, owner, sid, aid, replay))
      const artifact = await artifactRow(c, owner, sid, aid)
      const anchor = validateArtifactAnchor(agentArtifactDTO(artifact), input.anchor)
      await saveSnapshot(c, owner, artifact)
      const row = required(await one(c, `INSERT INTO agent_artifact_threads(owner_id,session_id,artifact_id,version,anchor)
        VALUES($1,$2,$3,1,$4::jsonb) RETURNING *`, [owner, sid, aid, JSON.stringify(anchor)]))
      await c.query(`INSERT INTO agent_artifact_messages(thread_id,body) VALUES($1,$2)`, [row.id, input.body])
      await saveReceipt(c, owner, input.clientRequestId, hash, row.id)
      return threadDTO(c, row)
    })
  }
  reply(owner: string, sessionId: string, artifactId: string, threadId: string, request: CreateAgentArtifactReplyRequest): Promise<AgentArtifactThreadDTO> {
    const sid = artifactUuid(sessionId), aid = artifactIdentity(artifactId), tid = artifactUuid(threadId), input = artifactReplyInput(request); artifactUuid(owner)
    const hash = digest({ operation: 'reply', sessionId: sid, artifactId: aid, threadId: tid, body: input.body })
    return this.tx(async c => {
      await scope(c, owner, sid, true)
      const row = await threadRow(c, owner, sid, aid, tid)
      const replay = await receipt(c, owner, input.clientRequestId, hash)
      if (!replay) {
        const count = required(await one(c, `SELECT count(*)::integer AS count FROM agent_artifact_messages WHERE thread_id=$1`, [tid]))
        if (Number(count.count) >= AGENT_ARTIFACT_MAX_MESSAGES) throw new AgentCoreError('CONFLICT')
        await c.query(`INSERT INTO agent_artifact_messages(thread_id,body) VALUES($1,$2)`, [tid, input.body])
        await saveReceipt(c, owner, input.clientRequestId, hash, tid)
      } else if (replay !== tid) throw new AgentCoreError('CONFLICT')
      return threadDTO(c, row)
    })
  }
  resolve(owner: string, sessionId: string, artifactId: string, threadId: string, request: ResolveAgentArtifactThreadRequest): Promise<AgentArtifactThreadDTO> {
    const sid = artifactUuid(sessionId), aid = artifactIdentity(artifactId), tid = artifactUuid(threadId), input = artifactResolveInput(request); artifactUuid(owner)
    return this.tx(async c => {
      await scope(c, owner, sid, true); await threadRow(c, owner, sid, aid, tid)
      const row = required(await one(c, `UPDATE agent_artifact_threads SET resolved=$5,
        resolved_at=CASE WHEN $5 THEN COALESCE(resolved_at,clock_timestamp()) ELSE NULL END
        WHERE owner_id=$1 AND session_id=$2 AND artifact_id=$3 AND id=$4 RETURNING *`, [owner, sid, aid, tid, input.resolved]))
      return threadDTO(c, row)
    })
  }
}

export * from './agent-artifact-validation'
