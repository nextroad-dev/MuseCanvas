import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentCoreClient, AgentCoreTransaction } from './agent-core'
import { AgentMediaRecoveryRepository } from './agent-media-recovery'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ownerId = uuid(1), sessionId = uuid(2), turnId = uuid(3), toolId = uuid(4)
const now = Date.parse('2026-11-17T08:00:00Z')
const TERMINAL_JOBS = ['succeeded', 'failed', 'canceled']
const TERMINAL_TOOLS = ['completed', 'failed', 'cancelled', 'skipped']
const MEDIA_FAILED = { code: 'TOOL_FAILED', message: 'Media job failed', retryable: false }

interface ResultItem {id:string;session_id:string;turn_id:string;sequence:string;item_type:string;tool_call_id:string;payload:any;created_at:Date}
interface SessionRow { next_item_sequence:string; active_turn_id:string|null; id: string; owner_id: string; next_event_cursor: string }
interface TurnRow {
  id: string; session_id: string; status: string; engine_version: string; revision: string; input_revision: string
  cancel_requested_at: Date | null; terminal_at: Date | null; deadline_at: Date; error: Record<string, unknown> | null
  updated_at: Date
}
interface ToolRow {
  id: string; session_id: string; turn_id: string; tool_name: string; status: string
  result: Record<string, unknown> | null; error: Record<string, unknown> | null; updated_at: Date
}
interface LinkRow {
  tool_call_id: string; session_id: string; turn_id: string; owner_id: string
  media_job_id: string; position: number; dependency_role: string
}
interface JobRow { id: string; status: string; created_by: string }
interface AssetRow { id: string; created_by: string; deleted_at: Date | null }
interface OutputRow { job_id: string; asset_id: string }
interface ReservationRow {
  id: string; session_id: string; turn_id: string; tool_call_id: string
  quota: string; status: string; settled_at: Date | null
  reserved_amount: string | null; currency: string | null; pricing_revision: string | null
}
interface UsageRow {
  session_id: string; turn_id: string; reservation_id: string; settlement_key: string
  usage_kind: string; amount: string; details: Record<string, unknown>; currency?: string
}
interface ApprovalRow { id: string; session_id: string; turn_id: string; status: string }
interface EventRow {
  session_id: string; turn_id: string; cursor: string; entity_revision: string
  event_type: string; payload: any
}
interface OutboxRow { event_type: string; aggregate_id: string; payload: any; dedupe_key: string | null }
interface State {
  items:ResultItem[];
  sessions: SessionRow[]; turns: TurnRow[]; tools: ToolRow[]; links: LinkRow[]; jobs: JobRow[]
  assets: AssetRow[]; outputs: OutputRow[]; reservations: ReservationRow[]; usages: UsageRow[]
  approvals: ApprovalRow[]; events: EventRow[]; outbox: OutboxRow[]
}

function initial(): State {
  return {
    items:[],
    sessions: [{ next_item_sequence:'1', active_turn_id:turnId, id: sessionId, owner_id: ownerId, next_event_cursor: '10' }],
    turns: [{
      id: turnId, session_id: sessionId, status: 'waiting_tools', engine_version: 'agent-core-v1',
      revision: '3', input_revision: '1', cancel_requested_at: null, terminal_at: null,
      deadline_at: new Date(now + 10000), error: null, updated_at: new Date(now),
    }],
    tools: [{
      id: toolId, session_id: sessionId, turn_id: turnId, tool_name: 'generate_image',
      status: 'waiting_external', result: null, error: null, updated_at: new Date(now),
    }],
    links: [], jobs: [], assets: [], outputs: [], reservations: [], usages: [], approvals: [], events: [], outbox: [],
  }
}

function addTool(state: State, id: string, status = 'waiting_external', updatedAt = now) {
  state.tools.push({
    id, session_id: sessionId, turn_id: turnId, tool_name: 'generate_image', status,
    result: null, error: null, updated_at: new Date(updatedAt),
  })
}
function addJob(state: State, tool: string, jobId: string, status: string, position: number,
  assets: { id: string; deleted?: boolean }[] = []) {
  state.jobs.push({ id: jobId, status, created_by: ownerId })
  state.links.push({
    tool_call_id: tool, session_id: sessionId, turn_id: turnId, owner_id: ownerId,
    media_job_id: jobId, position, dependency_role: 'output',
  })
  for (const asset of assets) {
    state.assets.push({ id: asset.id, created_by: ownerId, deleted_at: asset.deleted ? new Date(now) : null })
    state.outputs.push({ job_id: jobId, asset_id: asset.id })
  }
}
function addReservation(state: State, id: string, quota: string,
  price?: { amount: string; currency: string; pricingRevision: string }) {
  state.reservations.push({
    id, session_id: sessionId, turn_id: turnId, tool_call_id: toolId,
    quota, status: 'reserved', settled_at: null,
    reserved_amount: price?.amount ?? null, currency: price?.currency ?? null,
    pricing_revision: price?.pricingRevision ?? null,
  })
}

// Deliberately limited in-memory SQL model: it verifies the repository's
// predicates, bound parameters, effects and rollback propagation. It is NOT
// PostgreSQL SQL, trigger, isolation or concurrency validation.
function fixture(seed = initial()) {
  let state = seed, dbTime = now
  const calls: { sql: string; args: unknown[] }[] = []
  let commits = 0, rollbacks = 0
  let fail: RegExp | undefined
  let afterCandidate: (() => void) | undefined
  const copy = <T>(value: T): T => structuredClone(value)
  const at = () => new Date(dbTime)
  const arg = (args: unknown[], i: number) => String(args[i])

  const client = {
    async query(raw: string, args: unknown[] = []) {
      const sql = raw.replace(/\s+/g, ' ').trim()
      calls.push({ sql, args })
      const binds = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]))
      assert.equal(binds.length ? Math.max(...binds) : 0, args.length)
      if (fail?.test(sql)) throw new Error('injected SQL failure')
      if (sql.startsWith("SELECT id FROM agent_items")) return {rows:copy(state.items.filter(i=>i.tool_call_id===arg(args,0)))}
      if (sql.startsWith('UPDATE agent_sessions SET next_item_sequence=')) {
        const session=state.sessions.find(s=>s.id===arg(args,0))!;const sequence=session.next_item_sequence;session.next_item_sequence=String(BigInt(sequence)+1n);return {rows:[{sequence}]}
      }
      if (sql.startsWith('INSERT INTO agent_items')) {
        const item={id:`item-${state.items.length}`,session_id:arg(args,0),turn_id:arg(args,1),sequence:arg(args,2),item_type:arg(args,3),tool_call_id:arg(args,4),payload:JSON.parse(String(args[5])),created_at:at()};state.items.push(item);return {rows:[copy(item)]}
      }
      if (sql.startsWith('INSERT INTO agent_session_events') && sql.includes('item_sequence')) {
        state.events.push({session_id:arg(args,0),turn_id:arg(args,1),cursor:arg(args,2),entity_revision:state.turns[0]!.revision,event_type:arg(args,4),payload:JSON.parse(String(args[5]))});return {rows:[]}
      }
      if (sql.startsWith("UPDATE agent_turns t SET status='queued'")) {
        const turn=state.turns.find(t=>t.id===arg(args,2)&&t.session_id===arg(args,1));const session=state.sessions.find(s=>s.owner_id===arg(args,0)&&s.id===arg(args,1))
        if (!turn||session?.active_turn_id!==turn.id||!['waiting_tools','waiting_approval'].includes(turn.status)||turn.cancel_requested_at!==null||turn.deadline_at.getTime()<=dbTime) return {rows:[]}
        if(state.tools.some(t=>t.turn_id===turn.id&&(!TERMINAL_TOOLS.includes(t.status)||!state.items.some(i=>i.tool_call_id===t.id))))return {rows:[]}
        if(state.reservations.some(r=>r.turn_id===turn.id&&['reserved','unknown'].includes(r.status))||state.approvals.some(a=>a.turn_id===turn.id&&a.status==='pending'))return {rows:[]}
        turn.status='queued';turn.revision=String(BigInt(turn.revision)+1n);return {rows:[copy(turn)]}
      }


      if (sql.startsWith('SELECT x.id,x.turn_id,x.session_id,s.owner_id FROM agent_tool_calls x')) {
        const limit = Number(args[0])
        const linksOf = (tool: ToolRow) => state.links.filter(l => l.tool_call_id === tool.id
          && l.turn_id === tool.turn_id && l.session_id === tool.session_id)
        const candidates = state.tools.filter(tool => {
          if (tool.status !== 'waiting_external') return false
          const turn = state.turns.find(t => t.id === tool.turn_id && t.session_id === tool.session_id)
          if (!turn || !['completed', 'failed', 'cancelled'].includes(turn.status)) return false
          const links = linksOf(tool)
          return links.length > 0 && links.every(link => {
            const job = state.jobs.find(j => j.id === link.media_job_id && j.created_by === link.owner_id)
            return job !== undefined && TERMINAL_JOBS.includes(job.status)
          })
        }).sort((a, b) => a.turn_id.localeCompare(b.turn_id)
          || Math.min(...linksOf(a).map(l => l.position)) - Math.min(...linksOf(b).map(l => l.position))
          || a.id.localeCompare(b.id)).slice(0, limit)
        return { rows: copy(candidates.map(tool => ({
          id: tool.id, turn_id: tool.turn_id, session_id: tool.session_id,
          owner_id: state.sessions.find(s => s.id === tool.session_id)!.owner_id,
        }))) }
      }
      if (sql.startsWith('SELECT id FROM users WHERE id=')) return { rows: [{ id: arg(args, 0) }] }
      if (sql.startsWith('SELECT a.id FROM generation_outputs o JOIN assets a ON a.id=o.asset_id')) {
        const jobId = arg(args, 0), owner = arg(args, 1)
        const assets = state.outputs.filter(o => o.job_id === jobId)
          .map(o => state.assets.find(a => a.id === o.asset_id))
          .filter((asset): asset is AssetRow => asset !== undefined && asset.created_by === owner)
          .sort((a, b) => a.id.localeCompare(b.id))
        return { rows: copy(assets.map(asset => ({ id: asset.id }))) }
      }
      if (sql.startsWith('SELECT x.id,x.turn_id,x.session_id FROM agent_tool_calls x')) {
        const limit = Number(args[0])
        const candidates = state.tools.filter(tool => {
          if (tool.status !== 'waiting_external') return false
          const links = state.links.filter(l => l.tool_call_id === tool.id && l.turn_id === tool.turn_id
            && l.session_id === tool.session_id)
          if (!links.length) return false
          return links.every(l => {
            const job = state.jobs.find(j => j.id === l.media_job_id)
            return job !== undefined && TERMINAL_JOBS.includes(job.status)
          })
        }).sort((a, b) => a.updated_at.getTime() - b.updated_at.getTime() || a.id.localeCompare(b.id)).slice(0, limit)
        const rows = copy(candidates.map(tool => ({ id: tool.id, turn_id: tool.turn_id, session_id: tool.session_id })))
        afterCandidate?.()
        return { rows }
      }
      if (sql.startsWith('SELECT * FROM agent_sessions WHERE id=')) {
        return { rows: copy(state.sessions.filter(s=>s.id===arg(args,0))) }
      }
      if (sql.startsWith('SELECT * FROM agent_turns WHERE id=')) {
        return { rows: copy(state.turns.filter(t => t.id === arg(args, 0) && t.session_id === arg(args, 1)).slice(0, 1)) }
      }
      if (sql.startsWith('SELECT * FROM agent_tool_calls WHERE id=')) {
        return { rows: copy(state.tools.filter(t => t.id === arg(args, 0) && t.turn_id === arg(args, 1)
          && t.session_id === arg(args, 2) && t.status === 'waiting_external').slice(0, 1)) }
      }
      if(sql.startsWith('SELECT l.media_job_id,j.status'))return {rows:state.links.filter(l=>l.tool_call_id===arg(args,0)).map(l=>{const job=state.jobs.find(j=>j.id===l.media_job_id)!;return {media_job_id:job.id,status:job.status,output_count:String(job.status==='succeeded'?state.outputs.filter(o=>o.job_id===job.id&&state.assets.some(a=>a.id===o.asset_id&&a.deleted_at===null)).length:0),remote_uncertain:(job as {remote_uncertain?:boolean}).remote_uncertain??false}})}
      if (sql.startsWith('SELECT l.media_job_id,l.owner_id,l.position,j.status')) {
        const links = state.links.filter(l => l.tool_call_id === arg(args, 0) && l.turn_id === arg(args, 1)
          && l.session_id === arg(args, 2)).flatMap(l => {
          const job = state.jobs.find(j => j.id === l.media_job_id)
          return job ? [{ media_job_id: l.media_job_id, owner_id: l.owner_id, position: l.position, status: job.status }] : []
        }).sort((a, b) => a.position - b.position)
        return { rows: copy(links) }
      }
      if (sql.startsWith('SELECT o.job_id,o.asset_id FROM generation_outputs o')) {
        const jobIds = args[0] as string[], owner = arg(args, 1)
        const outputs = state.outputs.filter(o => jobIds.includes(o.job_id) && state.assets.some(a => a.id === o.asset_id
          && a.created_by === owner && a.deleted_at === null))
          .sort((a, b) => a.job_id.localeCompare(b.job_id) || a.asset_id.localeCompare(b.asset_id))
        return { rows: copy(outputs) }
      }
      if (sql.startsWith('SELECT * FROM agent_budget_reservations')) {
        const reservations = state.reservations.filter(r => r.tool_call_id === arg(args, 0)
          && r.turn_id === arg(args, 1) && r.session_id === arg(args, 2) && r.status === 'reserved')
          .sort((a, b) => a.id.localeCompare(b.id))
        return { rows: copy(reservations) }
      }
      if (sql.startsWith('UPDATE agent_turns SET revision=revision+1')) {
        const turn = state.turns.find(t => t.id === arg(args, 0) && t.session_id === arg(args, 1))
        if (!turn) return { rows: [] }
        turn.revision = String(BigInt(turn.revision) + 1n); turn.updated_at = at()
        return { rows: [copy(turn)] }
      }
      if (sql.startsWith('UPDATE agent_sessions SET next_event_cursor=next_event_cursor+1')) {
        const session = state.sessions.find(s => s.id === arg(args, 0))
        if (!session) return { rows: [] }
        const cursor = session.next_event_cursor
        session.next_event_cursor = String(BigInt(cursor) + 1n)
        return { rows: [{ cursor }] }
      }
      if (sql.startsWith('UPDATE agent_tool_calls SET status=$2')) {
        const tool = state.tools.find(t => t.id === arg(args, 0) && t.session_id === arg(args, 4) && t.turn_id === arg(args, 5))
        if (!tool || tool.status !== 'waiting_external') return { rows: [] }
        tool.status = arg(args, 1)
        tool.result = args[2] == null ? null : JSON.parse(String(args[2]))
        tool.error = args[3] == null ? null : JSON.parse(String(args[3]))
        tool.updated_at = at()
        return { rows: [copy(tool)] }
      }
      if (sql.startsWith('UPDATE agent_budget_reservations SET status=')) {
        const reservation = state.reservations.find(r => r.id === arg(args, 0) && r.tool_call_id === arg(args, 1)
          && r.turn_id === arg(args, 2) && r.session_id === arg(args, 3) && r.status === 'reserved')
        if (!reservation) return { rows: [] }
        reservation.status = sql.includes("status='settled'") ? 'settled'
          : sql.includes("status='released'") ? 'released' : 'unknown'
        reservation.settled_at = at()
        return { rows: [] }
      }
      if (sql.startsWith('INSERT INTO agent_usage_entries')) {
        if (state.usages.some(u => u.turn_id === arg(args, 1) && u.settlement_key === arg(args, 3))) return { rows: [] }
        const unknown = sql.includes("'unknown'"), priced = sql.includes('currency')
        const usage: UsageRow = {
          session_id: arg(args, 0), turn_id: arg(args, 1), reservation_id: arg(args, 2),
          settlement_key: arg(args, 3), usage_kind: unknown ? 'unknown' : 'actual', amount: arg(args, 4),
          details: JSON.parse(String(args[priced ? 6 : 5])),
        }
        if (priced) usage.currency = arg(args, 5)
        state.usages.push(usage)
        return { rows: [] }
      }
      if (sql.startsWith('INSERT INTO agent_session_events')) {
        state.events.push({
          session_id: arg(args, 0), turn_id: arg(args, 1), cursor: arg(args, 2), entity_revision: arg(args, 3),
          event_type: arg(args, 4), payload: JSON.parse(String(args[5])),
        })
        return { rows: [] }
      }
      if (sql.startsWith("UPDATE agent_turns SET status='queued'")) {
        const turn = state.turns.find(t => t.id === arg(args, 0) && t.session_id === arg(args, 1))
        if (!turn || !['waiting_tools', 'waiting_approval'].includes(turn.status) || turn.cancel_requested_at !== null) return { rows: [] }
        if (state.approvals.some(a => a.turn_id === turn.id && a.session_id === turn.session_id && a.status === 'pending')) return { rows: [] }
        if (state.tools.some(t => t.turn_id === turn.id && t.session_id === turn.session_id
          && !TERMINAL_TOOLS.includes(t.status))) return { rows: [] }
        turn.status = 'queued'; turn.revision = String(BigInt(turn.revision) + 1n); turn.updated_at = at()
        return { rows: [copy(turn)] }
      }
      if (sql.startsWith('INSERT INTO outbox_events')) {
        const dedupeKey = args[2] == null ? null : arg(args, 2)
        if (dedupeKey !== null && state.outbox.some(o => o.dedupe_key === dedupeKey)) return { rows: [] }
        state.outbox.push({
          event_type: 'agent.turn.wake', aggregate_id: arg(args, 0), payload: JSON.parse(String(args[1])),
          dedupe_key: dedupeKey,
        })
        return { rows: [] }
      }
      throw new Error(`unexpected fixture SQL: ${sql}`)
    },
  } as unknown as AgentCoreClient

  const tx: AgentCoreTransaction = async (work, readOnly = false) => {
    assert.equal(readOnly, false)
    const before = copy(state)
    try { const value = await work(client); commits++; return value }
    catch (error) { state = before; rollbacks++; throw error }
  }
  return {
    repo: new AgentMediaRecoveryRepository(tx), calls, get state() { return state }, get commits() { return commits },
    get rollbacks() { return rollbacks }, setTime(value: number) { dbTime = value }, failOn(value: RegExp) { fail = value },
    afterCandidate(fn: () => void) { afterCandidate = fn },
  }
}

test('agent-media-recovery: selects only waiting_external tools whose linked jobs are all terminal', async () => {
  const f = fixture()
  const pending = uuid(5)
  addTool(f.state, pending)
  addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])
  addJob(f.state, pending, uuid(21), 'running', 0, [{ id: uuid(31) }])

  assert.deepEqual(await f.repo.reconcileMediaJobs(10), { kind: 'media', processed: 1, remaining: false })
  assert.match(f.calls[0]!.sql, /x\.status='waiting_external'/)
  assert.match(f.calls[0]!.sql, /j\.status NOT IN \('succeeded','failed','canceled'\)/)
  assert.doesNotMatch(f.calls[0]!.sql, /FOR UPDATE/)
  assert.match(f.calls[1]!.sql, /FROM agent_sessions WHERE id=\$1 FOR UPDATE SKIP LOCKED$/)
  assert.match(f.calls[2]!.sql, /FROM agent_turns WHERE id=\$1 AND session_id=\$2 FOR UPDATE SKIP LOCKED$/)
  assert.deepEqual(f.calls[0]!.args, [10])
  assert.equal(f.state.tools.find(t => t.id === toolId)!.status, 'completed')
  assert.equal(f.state.tools.find(t => t.id === pending)!.status, 'waiting_external')
  assert.equal(f.state.tools.find(t => t.id === pending)!.result, null)
  assert.equal(f.state.events.filter(e => e.payload.tool?.id === pending).length, 0)
  assert.equal(f.state.outbox.length, 0)
})

const mappings: { name: string; secondJob: string; status: string; error: object | null; result: object | null }[] = [
  { name: 'completed', secondJob: 'succeeded', status: 'completed', error: null,
    result: { jobIds: [uuid(90), uuid(10)], assetIds: [uuid(20), uuid(80), uuid(70)] } },
  { name: 'failed', secondJob: 'failed', status: 'failed', error: MEDIA_FAILED, result: null },
  { name: 'canceled', secondJob: 'canceled', status: 'cancelled', error: {code:'TOOL_FAILED',message:'Media generation cancelled',retryable:false}, result: null },
]
for (const mapping of mappings) {
  test(`agent-media-recovery: maps ${mapping.name} jobs, orders ids by link position and excludes deleted assets`, async () => {
    const f = fixture()
    addJob(f.state, toolId, uuid(90), 'succeeded', 0,
      [{ id: uuid(80) }, { id: uuid(20) }, { id: uuid(10), deleted: true }])
    addJob(f.state, toolId, uuid(10), mapping.secondJob, 1, [{ id: uuid(70) }])

    assert.deepEqual(await f.repo.reconcileMediaJobs(10), { kind: 'media', processed: 1, remaining: false })
    const tool = f.state.tools.find(t => t.id === toolId)!
    assert.equal(tool.status, mapping.status)
    assert.deepEqual(tool.error, mapping.error)
    assert.deepEqual(tool.result, mapping.result)
    const updated = f.state.events.find(e => e.event_type === 'tool.updated')!
    assert.deepEqual(updated.payload, { tool: {
      id: toolId, turnId, toolName: 'generate_image', status: mapping.status, revision: '4',
    } })
  })
}

test('agent-media-recovery: settles media reservations by quota and leaves unrelated quotas reserved', async () => {
  const f = fixture()
  addJob(f.state, toolId, uuid(20), 'succeeded', 0,
    [{ id: uuid(30) }, { id: uuid(31) }, { id: uuid(32), deleted: true }])
  addJob(f.state, toolId, uuid(21), 'succeeded', 1, [{ id: uuid(33) }])
  const quotas = ['media_jobs', 'media_outputs', 'concurrent_media_jobs', 'estimated_cost', 'model_calls', 'tool_calls', 'input_tokens']
  quotas.forEach((quota, i) => addReservation(f.state, uuid(40 + i), quota))

  await f.repo.reconcileMediaJobs(10)

  const reservation = (quota: string) => f.state.reservations.find(r => r.quota === quota)!
  assert.equal(reservation('media_jobs').status, 'settled')
  assert.equal(reservation('media_outputs').status, 'settled')
  assert.equal(reservation('concurrent_media_jobs').status, 'released')
  assert.equal(reservation('estimated_cost').status, 'unknown')
  for (const quota of ['media_jobs', 'media_outputs', 'concurrent_media_jobs', 'estimated_cost']) {
    assert.equal(reservation(quota).settled_at?.getTime(), now)
  }
  for (const quota of ['model_calls', 'tool_calls', 'input_tokens']) {
    assert.equal(reservation(quota).status, 'reserved')
    assert.equal(reservation(quota).settled_at, null)
  }

  assert.equal(f.state.usages.length, 3)
  assert.deepEqual(f.state.usages.find(u => u.settlement_key === `media:jobs:${toolId}`), {
    session_id: sessionId, turn_id: turnId, reservation_id: uuid(40), settlement_key: `media:jobs:${toolId}`,
    usage_kind: 'actual', amount: '2', details: { quota: 'media_jobs' },
  })
  assert.deepEqual(f.state.usages.find(u => u.settlement_key === `media:outputs:${toolId}`), {
    session_id: sessionId, turn_id: turnId, reservation_id: uuid(41), settlement_key: `media:outputs:${toolId}`,
    usage_kind: 'actual', amount: '3', details: { quota: 'media_outputs' },
  })
})

test('agent-media-recovery: emits tool.updated, queues a fully terminal turn and writes one durable wake', async () => {
  const f = fixture()
  addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])

  await f.repo.reconcileMediaJobs(10)

  const turn = f.state.turns[0]!
  assert.equal(turn.status, 'queued')
  assert.equal(turn.revision, '5')
  assert.deepEqual(f.state.events.map(e => e.event_type), ['item.created','tool.updated','turn.updated'])
  assert.deepEqual(f.state.events.map(e => e.cursor), ['10','11','12'])
  assert.equal(f.state.events[0]!.entity_revision, '4')
  assert.equal(f.state.events[2]!.entity_revision, '5')
  assert.equal(f.state.events[2]!.payload.turn.status, 'queued')
  assert.equal(f.state.outbox.length, 1)
  assert.deepEqual(f.state.outbox[0], {
    event_type: 'agent.turn.wake', aggregate_id: turnId,
    payload: { schemaVersion: 1, sessionId, turnId, revision: '5' },
    dedupe_key: `agent:${turnId}:5`,
  })
})

test('agent-media-recovery: wake dedupe key prevents duplicate outbox rows', async () => {
  const f = fixture()
  addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])
  f.state.outbox.push({
    event_type: 'agent.turn.wake', aggregate_id: turnId, payload: {},
    dedupe_key: `agent:${turnId}:5`,
  })

  await f.repo.reconcileMediaJobs(10)

  assert.equal(f.state.turns[0]!.status, 'queued')
  assert.equal(f.state.outbox.length, 1)
})

const blockedWakeCases: { name: string; mutate: (state: State) => void; expectedStatus: string }[] = [
  {
    name: 'pending approval', expectedStatus: 'waiting_tools',
    mutate: state => { state.approvals.push({ id: uuid(50), session_id: sessionId, turn_id: turnId, status: 'pending' }) },
  },
  {
    name: 'non-terminal sibling tool', expectedStatus: 'waiting_tools',
    mutate: state => addTool(state, uuid(51), 'executing'),
  },
  {
    name: 'running turn', expectedStatus: 'running',
    mutate: state => { state.turns[0]!.status = 'running' },
  },
]
for (const blocked of blockedWakeCases) {
  test(`agent-media-recovery: does not wake with ${blocked.name}`, async () => {
    const f = fixture()
    addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])
    blocked.mutate(f.state)

    await f.repo.reconcileMediaJobs(10)

    assert.equal(f.state.turns[0]!.status, blocked.expectedStatus)
    assert.equal(f.state.events.filter(e => e.event_type === 'turn.updated').length, 0)
    assert.equal(f.state.outbox.length, 0)
  })
}

const cancelledCases: { name: string; mutate: (turn: TurnRow) => void }[] = [
  {
    name: 'terminal cancelled turn',
    mutate: turn => { turn.status = 'cancelled'; turn.terminal_at = new Date(now); turn.cancel_requested_at = new Date(now) },
  },
  { name: 'cancel-requested turn', mutate: turn => { turn.cancel_requested_at = new Date(now) } },
]
for (const cancelled of cancelledCases) {
  test(`agent-media-recovery: records media for a ${cancelled.name} but never wakes it`, async () => {
    const f = fixture()
    addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])
    cancelled.mutate(f.state.turns[0]!)

    await f.repo.reconcileMediaJobs(10)

    const turn = f.state.turns[0]!
    assert.equal(turn.status, cancelled.name.startsWith('terminal') ? 'cancelled' : 'waiting_tools')
    assert.equal(turn.revision, '4')
    assert.equal(f.state.tools[0]!.status, 'completed')
    assert.deepEqual(f.state.events.map(e => e.event_type), ['item.created','tool.updated'])
    assert.equal(f.state.outbox.length, 0)
  })
}

test('agent-media-recovery: a candidate changed after the unlocked read is skipped without writes', async () => {
  const f = fixture()
  addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])
  addReservation(f.state, uuid(40), 'media_jobs')
  f.afterCandidate(() => { f.state.tools[0]!.status = 'completed' })

  assert.deepEqual(await f.repo.reconcileMediaJobs(10), { kind: 'media', processed: 0, remaining: false })
  assert.equal(f.state.turns[0]!.revision, '3')
  assert.equal(f.state.events.length, 0)
  assert.equal(f.state.outbox.length, 0)
  assert.equal(f.state.usages.length, 0)
  assert.equal(f.state.reservations[0]!.status, 'reserved')
  assert.equal(f.commits, 1)
})

test('agent-media-recovery: honors limit and reports remaining work across sweeps', async () => {
  const f = fixture()
  const second = uuid(5)
  addTool(f.state, second, 'waiting_external', now + 1)
  addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])
  addJob(f.state, second, uuid(21), 'succeeded', 0, [{ id: uuid(31) }])

  assert.deepEqual(await f.repo.reconcileMediaJobs(1), { kind: 'media', processed: 1, remaining: true })
  assert.equal(f.state.tools.find(t => t.id === toolId)!.status, 'completed')
  assert.equal(f.state.tools.find(t => t.id === second)!.status, 'waiting_external')
  assert.equal(f.state.outbox.length, 0)

  assert.deepEqual(await f.repo.reconcileMediaJobs(2), { kind: 'media', processed: 1, remaining: false })
  assert.equal(f.state.tools.find(t => t.id === second)!.status, 'completed')
  assert.equal(f.state.turns[0]!.status, 'queued')
  assert.equal(f.state.outbox.length, 1)
})

test('agent-media-recovery: a replayed sweep after terminal transition is a no-op', async () => {
  const f = fixture()
  addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])
  addReservation(f.state, uuid(40), 'media_jobs')
  await f.repo.reconcileMediaJobs(10)

  const settled = structuredClone(f.state)
  assert.deepEqual(await f.repo.reconcileMediaJobs(10), { kind: 'media', processed: 0, remaining: false })
  assert.deepEqual(f.state, settled)
})

test('agent-media-recovery: rejects non-integer or out-of-range limits before opening a transaction', () => {
  const f = fixture()
  for (const limit of [0, -1, 1.5, NaN, Infinity, 1001]) {
    assert.throws(() => f.repo.reconcileMediaJobs(limit), { code: 'INVALID_INPUT' })
  }
  assert.equal(f.calls.length, 0)
  assert.equal(f.commits, 0)
})

test('agent-media-recovery: SQL failure rolls back tool, turn, event and settlement writes', async () => {
  const f = fixture()
  addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])
  addReservation(f.state, uuid(40), 'media_jobs')
  const before = structuredClone(f.state)
  f.failOn(/INSERT INTO agent_session_events/)

  await assert.rejects(f.repo.reconcileMediaJobs(10), /injected SQL failure/)

  assert.deepEqual(f.state, before)
  assert.equal(f.rollbacks, 1)
  assert.equal(f.commits, 0)
})

test('agent-media-recovery: settleAbandonedMedia settles a cancelled turn whose job succeeded exactly once', async () => {
  const f = fixture()
  f.state.turns[0]!.status = 'cancelled'
  f.state.turns[0]!.terminal_at = new Date(now)
  addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])
  addReservation(f.state, uuid(40), 'media_jobs')
  addReservation(f.state, uuid(41), 'media_outputs')
  addReservation(f.state, uuid(42), 'concurrent_media_jobs')
  addReservation(f.state, uuid(43), 'estimated_cost',
    { amount: '0', currency: 'USD', pricingRevision: 'pricing-1' })
  const job = structuredClone(f.state.jobs[0])

  assert.deepEqual(await f.repo.settleAbandonedMedia(10), { kind: 'media', processed: 1, remaining: false })

  assert.match(f.calls[0]!.sql, /x\.status='waiting_external' AND t\.status IN \('completed','failed','cancelled'\)/)
  assert.match(f.calls[0]!.sql, /NOT EXISTS \(SELECT 1 FROM agent_tool_job_links l JOIN generation_jobs j/)
  assert.doesNotMatch(f.calls[0]!.sql, /FOR UPDATE/)
  assert.match(f.calls[1]!.sql, /FROM users WHERE id=\$1 FOR NO KEY UPDATE$/)
  assert.match(f.calls[2]!.sql, /FROM agent_sessions WHERE id=\$1 AND owner_id=\$2 FOR UPDATE SKIP LOCKED$/)
  assert.match(f.calls[3]!.sql, /FROM agent_turns WHERE id=\$1 AND session_id=\$2 AND status IN/)
  assert.match(f.calls[4]!.sql, /FROM agent_tool_calls WHERE id=\$1 .* status='waiting_external' FOR UPDATE$/)

  const turn = f.state.turns[0]!
  assert.equal(turn.status, 'cancelled')
  assert.equal(turn.revision, '3')
  assert.equal(turn.cancel_requested_at, null)
  assert.equal(f.state.sessions[0]!.active_turn_id, turnId)
  const tool = f.state.tools.find(t => t.id === toolId)!
  assert.equal(tool.status, 'completed')
  assert.equal(tool.error, null)
  assert.deepEqual(tool.result, {
    content: `Media generation completed: ${uuid(20)}`,
    jobs: [{ jobId: uuid(20), status: 'succeeded', assetIds: [uuid(30)] }],
  })
  assert.deepEqual(f.state.jobs[0], job)

  const reservation = (quota: string) => f.state.reservations.find(r => r.quota === quota)!
  assert.equal(reservation('media_jobs').status, 'settled')
  assert.equal(reservation('media_outputs').status, 'settled')
  assert.equal(reservation('concurrent_media_jobs').status, 'released')
  assert.equal(reservation('estimated_cost').status, 'settled')
  assert.deepEqual(f.state.usages.find(u => u.settlement_key === `media:cost:${uuid(43)}`), {
    session_id: sessionId, turn_id: turnId, reservation_id: uuid(43),
    settlement_key: `media:cost:${uuid(43)}`, usage_kind: 'actual', amount: '0', currency: 'USD',
    details: { quota: 'estimated_cost', reason: 'zero_price_revision', pricingRevision: 'pricing-1' },
  })

  assert.equal(f.state.items.filter(i => i.tool_call_id === toolId && i.item_type === 'tool_result').length, 1)
  assert.deepEqual(f.state.events.map(e => e.event_type), ['item.created', 'tool.updated'])
  assert.equal(f.state.outbox.length, 0)
  assert.equal(f.commits, 1)

  // Replay: the paired Tool is no longer a candidate and nothing is rewritten.
  const settled = structuredClone(f.state)
  assert.deepEqual(await f.repo.settleAbandonedMedia(10), { kind: 'media', processed: 0, remaining: false })
  assert.deepEqual(f.state, settled)
})

test('agent-media-recovery: settleAbandonedMedia skips a terminal turn whose linked job is still running', async () => {
  const f = fixture()
  f.state.turns[0]!.status = 'completed'
  addJob(f.state, toolId, uuid(20), 'running', 0, [])
  addReservation(f.state, uuid(40), 'media_jobs')
  const before = structuredClone(f.state)

  assert.deepEqual(await f.repo.settleAbandonedMedia(10), { kind: 'media', processed: 0, remaining: false })

  assert.deepEqual(f.state, before)
  assert.equal(f.commits, 1)
  assert.equal(f.state.usages.length, 0)
})

test('agent-media-recovery: settleAbandonedMedia skips an already-paired tool without duplicate items or events', async () => {
  const f = fixture()
  f.state.turns[0]!.status = 'cancelled'
  addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])
  addReservation(f.state, uuid(40), 'media_jobs')
  f.state.items.push({
    id: 'item-0', session_id: sessionId, turn_id: turnId, sequence: '0', item_type: 'tool_result',
    tool_call_id: toolId, payload: { content: 'paired elsewhere' }, created_at: new Date(now),
  })
  const before = structuredClone(f.state)

  assert.deepEqual(await f.repo.settleAbandonedMedia(10), { kind: 'media', processed: 0, remaining: false })

  assert.deepEqual(f.state, before)
  assert.equal(f.state.items.length, 1)
  assert.equal(f.state.events.length, 0)
  assert.equal(f.state.usages.length, 0)
  assert.equal(f.state.reservations[0]!.status, 'reserved')
})

test('agent-media-recovery: settleAbandonedMedia ignores a turn that is still waiting_tools', async () => {
  const f = fixture()
  addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])
  addReservation(f.state, uuid(40), 'media_jobs')
  const before = structuredClone(f.state)

  assert.deepEqual(await f.repo.settleAbandonedMedia(10), { kind: 'media', processed: 0, remaining: false })

  assert.deepEqual(f.state, before)
})

test('agent-media-recovery: settleAbandonedMedia maps terminal failures and honors the limit', async () => {
  const f = fixture()
  const second = uuid(5)
  f.state.turns[0]!.status = 'failed'
  addTool(f.state, second, 'waiting_external', now + 1)
  addJob(f.state, toolId, uuid(20), 'failed', 0)
  addJob(f.state, second, uuid(21), 'canceled', 0)

  assert.deepEqual(await f.repo.settleAbandonedMedia(1), { kind: 'media', processed: 1, remaining: true })
  const failed = f.state.tools.find(t => t.id === toolId)!
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.error, { code: 'TOOL_FAILED', message: 'Media generation failed', retryable: false })
  assert.deepEqual(failed.result, {
    content: 'Media generation failed.',
    jobs: [{ jobId: uuid(20), status: 'failed', assetIds: [] }],
  })
  assert.equal(f.state.tools.find(t => t.id === second)!.status, 'waiting_external')

  assert.deepEqual(await f.repo.settleAbandonedMedia(10), { kind: 'media', processed: 1, remaining: false })
  const cancelled = f.state.tools.find(t => t.id === second)!
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(cancelled.error, { code: 'TOOL_FAILED', message: 'Media generation cancelled', retryable: false })
  assert.deepEqual(cancelled.result, {
    content: 'Media generation cancelled.',
    jobs: [{ jobId: uuid(21), status: 'canceled', assetIds: [] }],
  })
})

test('agent-media-recovery: settleAbandonedMedia rejects invalid limits before opening a transaction', () => {
  const f = fixture()
  for (const limit of [0, -1, 1.5, NaN, Infinity, 1001]) {
    assert.throws(() => f.repo.settleAbandonedMedia(limit), { code: 'INVALID_INPUT' })
  }
  assert.equal(f.calls.length, 0)
  assert.equal(f.commits, 0)
})

test('agent-media-recovery: settleAbandonedMedia never opens a transaction, requeues or wakes the turn', async () => {
  const f = fixture()
  f.state.turns[0]!.status = 'cancelled'
  addJob(f.state, toolId, uuid(20), 'succeeded', 0, [{ id: uuid(30) }])

  await f.repo.settleAbandonedMedia(10)

  for (const call of f.calls) {
    assert.doesNotMatch(call.sql, /^(BEGIN|COMMIT|ROLLBACK)\b/i)
    assert.doesNotMatch(call.sql, /outbox_events/)
    assert.doesNotMatch(call.sql, /UPDATE agent_turns SET status=/)
    assert.doesNotMatch(call.sql, /UPDATE agent_turns SET revision=revision\+1/)
    assert.doesNotMatch(call.sql, /UPDATE agent_sessions SET active_turn_id=/)
  }
  assert.equal(f.commits, 1)
  assert.equal(f.rollbacks, 0)
  assert.equal(f.state.outbox.length, 0)
  assert.equal(f.state.turns[0]!.status, 'cancelled')
  assert.equal(f.state.events.filter(e => e.event_type === 'turn.updated').length, 0)
})
