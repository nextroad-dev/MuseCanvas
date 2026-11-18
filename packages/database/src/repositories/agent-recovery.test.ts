import assert from 'node:assert/strict'
import test from 'node:test'
import { agentTurnDTO, type AgentCoreClient, type AgentCoreTransaction } from './agent-core'
import { AgentRecoveryRepository } from './agent-recovery'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ownerId = uuid(1), sessionId = uuid(2), turnId = uuid(3), toolId = uuid(4)
const approvalId = uuid(5), reservationId = uuid(6), externalToolId = uuid(7)
const externalReservationId = uuid(8), modelReservationId = uuid(9)
const otherApprovalId = uuid(10), otherToolId = uuid(11)
const finishedToolId = uuid(12), finishedReservationId = uuid(13)
const now = Date.parse('2026-11-17T08:00:00Z')
const NON_TERMINAL = ['queued', 'running', 'waiting_tools', 'waiting_approval']
const LOCAL = ['recorded', 'validating', 'waiting_approval', 'executing']
const TERMINAL_TOOL = ['completed', 'failed', 'cancelled', 'skipped']
const DEADLINE_ERROR = { code: 'DEADLINE_EXCEEDED', message: 'Agent turn deadline exceeded', retryable: false }
const APPROVAL_ERROR = { code: 'APPROVAL_EXPIRED', message: 'Agent approval expired', retryable: false }
const UNOBSERVED_MEDIA_ERROR = { code: 'TOOL_FAILED', message: 'Media outcome was not observed before the turn ended', retryable: false }

interface ResultItem {id:string;session_id:string;turn_id:string;sequence:string;item_type:string;tool_call_id:string;payload:any;created_at:Date}
interface SessionRow { next_item_sequence:string; id: string; owner_id: string; active_turn_id: string | null; next_event_cursor: string }
interface TurnRow {
  id: string; session_id: string; status: string; engine_version: string; revision: string; input_revision: string
  cancel_requested_at: Date | null; terminal_at: Date | null; deadline_at: Date; error: Record<string, unknown> | null
  lease_owner: string | null; lease_until: Date | null; fencing_token: string; next_action_at: Date | null; updated_at: Date
}
interface ApprovalRow {
  id: string; session_id: string; turn_id: string; tool_call_id: string; reservation_id: string
  arguments_hash?:string;model_revision?:string;pricing_revision?:string;resolved_by?:string|null;
  status: string; expires_at: Date; resolved_at: Date | null; decision_revision: string | null
}
interface ToolRow {
  id: string; session_id: string; turn_id: string; tool_name: string; status: string
  result: Record<string, unknown> | null; error: Record<string, unknown> | null; updated_at: Date
}
interface ReservationRow { round_id?:string|null;quota?:string;reserved_amount?:string; id: string; session_id: string; turn_id: string; tool_call_id: string | null; status: string; settled_at: Date | null }
interface LinkRow { tool_call_id: string; session_id: string; turn_id: string; media_job_id: string }
interface EventRow { session_id: string; turn_id: string; cursor: string; entity_revision: string; event_type: string; payload: any }
interface OutboxRow {
  event_type: string; aggregate_id: string; payload: any; dedupe_key: string | null
  created_at: Date; dispatched_at: Date | null; quarantined_at: Date | null
}
interface State {
  items:ResultItem[];rounds:{id:string;status:string}[];usages:{quota:string|undefined;amount:string|undefined;reason:string}[];
  sessions: SessionRow[]; turns: TurnRow[]; approvals: ApprovalRow[]; tools: ToolRow[]
  reservations: ReservationRow[]; events: EventRow[]; outbox: OutboxRow[]; links: LinkRow[]
}

function initial(): State {
  return {
    items:[],rounds:[],usages:[],
    sessions: [{ next_item_sequence:'1', id: sessionId, owner_id: ownerId, active_turn_id: turnId, next_event_cursor: '1' }],
    turns: [{
      id: turnId, session_id: sessionId, status: 'running', engine_version: 'agent-core-v1', revision: '2', input_revision: '1',
      cancel_requested_at: null, terminal_at: null, deadline_at: new Date(now + 10000), error: null,
      lease_owner: 'worker-a', lease_until: new Date(now + 5000), fencing_token: '1', next_action_at: null, updated_at: new Date(now),
    }],
    approvals: [{
      id: approvalId, session_id: sessionId, turn_id: turnId, tool_call_id: toolId, reservation_id: reservationId,
      arguments_hash:'a'.repeat(64),model_revision:'language-revision',pricing_revision:'price-v1',resolved_by:null,
      status: 'pending', expires_at: new Date(now - 1), resolved_at: null, decision_revision: null,
    }],
    tools: [{
      id: toolId, session_id: sessionId, turn_id: turnId, tool_name: 'generate_image', status: 'waiting_approval',
      result: null, error: null, updated_at: new Date(now),
    }],
    reservations: [{
      id: reservationId, session_id: sessionId, turn_id: turnId, tool_call_id: toolId, status: 'reserved', settled_at: null,
    }],
    events: [], outbox: [], links: [],
  }
}

// Deliberately limited in-memory SQL model: it verifies the repository's
// predicates, bound parameters, effects and rollback propagation. It is NOT
// PostgreSQL SQL, trigger, isolation or concurrency validation.
function fixture(seed = initial()) {
  let state = seed, dbTime = now
  const calls: { sql: string; args: unknown[] }[] = []
  let commits = 0, rollbacks = 0, fail: RegExp | undefined
  const copy = <T>(value: T): T => structuredClone(value)
  const at = () => new Date(dbTime)
  const arg = (args: unknown[], i: number) => String(args[i])
  const nonTerminal = (status: string) => NON_TERMINAL.includes(status)
  const terminalTool = (status: string) => TERMINAL_TOOL.includes(status)

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
        if(state.tools.some(t=>t.turn_id===turn.id&&(!TERMINAL_TOOL.includes(t.status)||!state.items.some(i=>i.tool_call_id===t.id))))return {rows:[]}
        if(state.reservations.some(r=>r.turn_id===turn.id&&['reserved','unknown'].includes(r.status))||state.approvals.some(a=>a.turn_id===turn.id&&a.status==='pending'))return {rows:[]}
        turn.status='queued';turn.revision=String(BigInt(turn.revision)+1n);return {rows:[copy(turn)]}
      }


      if(sql.startsWith('WITH uncertain AS')) {
        for(const r of state.reservations)if(r.turn_id===arg(args,0)&&r.session_id===arg(args,1)&&r.status==='reserved'&&r.tool_call_id===null&&r.round_id!=null){r.status='unknown';r.settled_at=at();state.usages.push({quota:r.quota,amount:r.reserved_amount,reason:arg(args,2)})}
        return {rows:[]}
      }
      if(sql.startsWith('UPDATE agent_model_rounds')){for(const r of state.rounds)if(['recorded','running'].includes(r.status))r.status='failed';return {rows:[]}}
      if (sql.startsWith('SELECT id,session_id FROM agent_turns t WHERE')) {
        const limit = Number(args[0])
        const rows = sql.includes('deadline_at<=clock_timestamp()')
          ? state.turns.filter(t => nonTerminal(t.status) && t.deadline_at.getTime() <= dbTime)
            .sort((a, b) => a.deadline_at.getTime() - b.deadline_at.getTime() || a.id.localeCompare(b.id))
          : state.turns.filter(t => nonTerminal(t.status) && t.cancel_requested_at !== null
            && (t.lease_owner === null || (t.lease_until !== null && t.lease_until.getTime() <= dbTime)))
            .sort((a, b) => (a.cancel_requested_at?.getTime() ?? 0) - (b.cancel_requested_at?.getTime() ?? 0) || a.id.localeCompare(b.id))
        return { rows: copy(rows.slice(0, limit).map(t => ({ id: t.id, session_id: t.session_id }))) }
      }
      if (sql.startsWith('SELECT id,session_id FROM agent_turns WHERE')) {
        const limit = Number(args[0])
        return { rows: copy(state.turns.filter(t => t.status === 'running' && t.lease_owner !== null
          && t.lease_until !== null && t.lease_until.getTime() <= dbTime
          && t.deadline_at.getTime() > dbTime && t.cancel_requested_at === null)
          .sort((a, b) => (a.lease_until?.getTime() ?? 0) - (b.lease_until?.getTime() ?? 0) || a.id.localeCompare(b.id))
          .slice(0, limit).map(t => ({ id: t.id, session_id: t.session_id }))) }
      }
      if (sql.startsWith('SELECT * FROM agent_sessions WHERE id=')) {
        return { rows: copy(state.sessions.filter(s => s.id === arg(args, 0)).slice(0, 1)) }
      }
      if (sql.startsWith('SELECT * FROM agent_turns WHERE id=')) {
        let rows = state.turns.filter(t => t.id === arg(args, 0) && t.session_id === arg(args, 1))
        if (sql.includes('deadline_at<=clock_timestamp()')) rows = rows.filter(t => nonTerminal(t.status) && t.deadline_at.getTime() <= dbTime)
        else if (sql.includes('cancel_requested_at IS NOT NULL')) rows = rows.filter(t => nonTerminal(t.status)
          && t.cancel_requested_at !== null && (t.lease_owner === null || (t.lease_until !== null && t.lease_until.getTime() <= dbTime)))
        else if (sql.includes("status='running'")) rows = rows.filter(t => t.status === 'running' && t.lease_owner !== null
          && t.lease_until !== null && t.lease_until.getTime() <= dbTime
          && t.deadline_at.getTime() > dbTime && t.cancel_requested_at === null)
        else rows = rows.filter(t => nonTerminal(t.status))
        return { rows: copy(rows.slice(0, 1)) }
      }
      if (sql.startsWith('SELECT * FROM agent_tool_calls WHERE id=')) {
        return { rows: copy(state.tools.filter(t => t.id === arg(args, 0) && t.turn_id === arg(args, 1)
          && t.session_id === arg(args, 2)).slice(0, 1)) }
      }
      if (sql.startsWith('SELECT * FROM agent_approvals WHERE id=')) {
        return { rows: copy(state.approvals.filter(a => a.id === arg(args, 0) && a.turn_id === arg(args, 1)
          && a.session_id === arg(args, 2) && a.status === 'pending' && a.expires_at.getTime() <= dbTime).slice(0, 1)) }
      }
      if (sql.startsWith('SELECT a.')) {
        const limit = Number(args[0])
        return { rows: copy(state.approvals.filter(a => a.status === 'pending' && a.expires_at.getTime() <= dbTime
          && state.turns.some(t => t.id === a.turn_id && t.session_id === a.session_id && nonTerminal(t.status)))
          .sort((a, b) => a.expires_at.getTime() - b.expires_at.getTime() || a.id.localeCompare(b.id))
          .slice(0, limit).map(a => ({
            id: a.id, turn_id: a.turn_id, session_id: a.session_id, tool_call_id: a.tool_call_id,
            reservation_id: a.reservation_id,
          }))) }
      }
      if (sql.startsWith('SELECT 1 AS present FROM agent_approvals')) {
        return { rows: state.approvals.some(a => a.turn_id === arg(args, 0) && a.session_id === arg(args, 1) && a.status === 'pending')
          ? [{ present: 1 }] : [] }
      }
      if (sql.startsWith('SELECT 1 AS present FROM agent_tool_calls')) {
        return { rows: state.tools.some(t => t.turn_id === arg(args, 0) && t.session_id === arg(args, 1) && !terminalTool(t.status))
          ? [{ present: 1 }] : [] }
      }
      if (sql.startsWith('SELECT COUNT(*) FILTER')) {
        const pending = state.outbox.filter(o => o.dispatched_at === null && o.quarantined_at === null)
        const oldest = pending.length ? Math.max(0, dbTime - Math.min(...pending.map(o => o.created_at.getTime()))) : null
        return { rows: [{ pending: String(pending.length), oldest_age_ms: oldest,
          quarantined: String(state.outbox.filter(o => o.quarantined_at !== null).length) }] }
      }
      if (sql.startsWith("UPDATE agent_approvals SET status='expired'")) {
        const byId = sql.includes('decision_revision=$4')
        for (const approval of state.approvals) {
          const matches = byId
            ? approval.id === arg(args, 0) && approval.turn_id === arg(args, 1) && approval.session_id === arg(args, 2)
            : approval.turn_id === arg(args, 0) && approval.session_id === arg(args, 1)
          if (matches && approval.status === 'pending') {
            approval.status = 'expired'; approval.resolved_at = at()
            approval.decision_revision = String(byId ? args[3] : args[2])
          }
        }
        return { rows: copy(state.approvals.filter(a=>a.status==='expired' && a.decision_revision===String(byId?args[3]:args[2]))) }
      }
      if (sql.startsWith("UPDATE agent_tool_calls SET status='failed',error=$4::jsonb")) {
        const found = state.tools.find(t => t.id === arg(args, 0) && t.turn_id === arg(args, 1)
          && t.session_id === arg(args, 2) && t.status === 'waiting_approval')
        if (!found) return { rows: [] }
        found.status = 'failed'; found.error = JSON.parse(String(args[3])); found.updated_at = at()
        return { rows: [copy(found)] }
      }
      if (sql.startsWith("UPDATE agent_tool_calls SET status='failed',error=$3::jsonb")) {
        const rows: ToolRow[] = []
        for (const tool of state.tools) {
          if (tool.turn_id === arg(args, 0) && tool.session_id === arg(args, 1) && LOCAL.includes(tool.status)) {
            tool.status = 'failed'; tool.error = JSON.parse(String(args[2])); tool.updated_at = at(); rows.push(copy(tool))
          }
        }
        return { rows }
      }
      if (sql.startsWith("UPDATE agent_tool_calls SET status='cancelled',error=$3::jsonb")) {
        const rows: ToolRow[] = []
        for (const tool of state.tools) {
          if (tool.turn_id === arg(args, 0) && tool.session_id === arg(args, 1) && LOCAL.includes(tool.status)) {
            tool.status = 'cancelled'; tool.error = JSON.parse(String(args[2])); tool.updated_at = at(); rows.push(copy(tool))
          }
        }
        return { rows }
      }
      if (sql.startsWith("UPDATE agent_tool_calls x SET status='failed',error=$3::jsonb")) {
        const rows: ToolRow[] = []
        for (const tool of state.tools) {
          if (tool.turn_id !== arg(args, 0) || tool.session_id !== arg(args, 1) || tool.status !== 'waiting_external') continue
          if (state.links.some(link => link.tool_call_id === tool.id && link.turn_id === tool.turn_id && link.session_id === tool.session_id)) continue
          tool.status = 'failed'; tool.error = JSON.parse(String(args[2])); tool.updated_at = at(); rows.push(copy(tool))
        }
        return { rows }
      }
      if (sql.startsWith('UPDATE agent_budget_reservations r SET')) {
        for (const reservation of state.reservations) {
          if (reservation.turn_id !== arg(args, 0) || reservation.session_id !== arg(args, 1) || reservation.status !== 'reserved') continue
          const linked = reservation.tool_call_id === null ? undefined
            : state.tools.find(t => t.id === reservation.tool_call_id && t.turn_id === reservation.turn_id && t.session_id === reservation.session_id)
          if ((reservation.tool_call_id === null && reservation.round_id == null) || (linked && terminalTool(linked.status))) {
            reservation.status = 'released'; reservation.settled_at = at()
          }
        }
        return { rows: [] }
      }
      if (sql.startsWith('UPDATE agent_budget_reservations SET')) {
        if (sql.includes('WHERE id=$1')) {
          const reservation = state.reservations.find(r => r.id === arg(args, 0) && r.turn_id === arg(args, 1)
            && r.session_id === arg(args, 2) && r.status === 'reserved')
          if (reservation) { reservation.status = 'released'; reservation.settled_at = at() }
        } else {
          for (const reservation of state.reservations) {
            if (reservation.turn_id === arg(args, 0) && reservation.session_id === arg(args, 1) && reservation.status === 'reserved') {
              reservation.status = 'released'; reservation.settled_at = at()
            }
          }
        }
        return { rows: [] }
      }
      if (sql.startsWith("UPDATE agent_turns SET status='failed'")) {
        const found = state.turns.find(t => t.id === arg(args, 0) && t.session_id === arg(args, 1) && nonTerminal(t.status))
        if (!found) return { rows: [] }
        found.status = 'failed'; found.terminal_at = at(); found.error = JSON.parse(String(args[2]))
        found.lease_owner = null; found.lease_until = null
        found.revision = String(BigInt(found.revision) + 1n); found.updated_at = at()
        return { rows: [copy(found)] }
      }
      if (sql.startsWith("UPDATE agent_turns SET status='cancelled'")) {
        const found = state.turns.find(t => t.id === arg(args, 0) && t.session_id === arg(args, 1) && nonTerminal(t.status))
        if (!found) return { rows: [] }
        found.status = 'cancelled'; found.terminal_at = at(); found.lease_owner = null; found.lease_until = null
        found.revision = String(BigInt(found.revision) + 1n); found.updated_at = at()
        return { rows: [copy(found)] }
      }
      if (sql.startsWith("UPDATE agent_turns SET status='queued'")) {
        const found = state.turns.find(t => t.id === arg(args, 0) && t.session_id === arg(args, 1)
          && t.status === 'waiting_approval' && t.cancel_requested_at === null)
        if (!found) return { rows: [] }
        found.status = 'queued'; found.revision = String(BigInt(found.revision) + 1n); found.updated_at = at()
        return { rows: [copy(found)] }
      }
      if (sql.startsWith('UPDATE agent_turns SET revision=revision+1')) {
        const found = state.turns.find(t => t.id === arg(args, 0) && t.session_id === arg(args, 1) && nonTerminal(t.status))
        if (!found) return { rows: [] }
        found.revision = String(BigInt(found.revision) + 1n); found.updated_at = at()
        return { rows: [copy(found)] }
      }
      if (sql.startsWith('UPDATE agent_turns SET lease_owner=NULL')) {
        const found = state.turns.find(t => t.id === arg(args, 0) && t.session_id === arg(args, 1)
          && t.status === 'running' && t.lease_owner !== null && t.lease_until !== null && t.lease_until.getTime() <= dbTime
          && t.deadline_at.getTime() > dbTime && t.cancel_requested_at === null)
        if (!found) return { rows: [] }
        found.lease_owner = null; found.lease_until = null; found.next_action_at = at(); found.updated_at = at()
        return { rows: [copy(found)] }
      }
      if (sql.startsWith('UPDATE agent_sessions SET active_turn_id=NULL')) {
        const found = state.sessions.find(s => s.id === arg(args, 0))
        if (found && found.active_turn_id === arg(args, 1)) found.active_turn_id = null
        return { rows: [] }
      }
      if (sql.startsWith('UPDATE agent_sessions SET next_event_cursor=')) {
        const found = state.sessions.find(s => s.id === arg(args, 0))
        assert.ok(found, 'event cursor requires an existing session')
        const cursor = found.next_event_cursor
        found.next_event_cursor = String(BigInt(cursor) + 1n)
        return { rows: [{ cursor }] }
      }
      if (sql.startsWith('INSERT INTO agent_session_events')) {
        state.events.push({ session_id: arg(args, 0), turn_id: arg(args, 1), cursor: arg(args, 2), entity_revision: arg(args, 3),
          event_type: arg(args, 4), payload: JSON.parse(String(args[5])) })
        return { rows: [] }
      }
      if (sql.startsWith('INSERT INTO outbox_events')) {
        const dedupe = arg(args, 2)
        if (!state.outbox.some(o => o.dedupe_key === dedupe)) {
          state.outbox.push({ event_type: 'agent.turn.wake', aggregate_id: arg(args, 0), payload: JSON.parse(String(args[1])),
            dedupe_key: dedupe, created_at: at(), dispatched_at: null, quarantined_at: null })
        }
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
    repo: new AgentRecoveryRepository(tx), calls, get state() { return state }, get commits() { return commits },
    get rollbacks() { return rollbacks }, setTime(value: number) { dbTime = value }, failOn(value: RegExp) { fail = value },
  }
}
type Fixture = ReturnType<typeof fixture>

const turnEvent = (turn: TurnRow, overrides: Partial<TurnRow> = {}) => ({ turn: agentTurnDTO({ ...turn, ...overrides }) })

test('agent-recovery: deadline sweep expires approvals, fails local tools, releases all reservations and terminalizes once', async () => {
  const f = fixture()
  const t = f.state.turns[0]!
  t.revision = '5'; t.deadline_at = new Date(now - 1); t.lease_owner = 'worker-a'; t.lease_until = new Date(now + 5000)
  f.state.approvals[0]!.expires_at = new Date(now + 60000)
  f.state.tools.push({ id: externalToolId, session_id: sessionId, turn_id: turnId, tool_name: 'generate_video',
    status: 'waiting_external', result: { assetId: 'asset-1' }, error: null, updated_at: new Date(now) })
  f.state.links.push({ tool_call_id: externalToolId, session_id: sessionId, turn_id: turnId, media_job_id: 'job-external' })
  f.state.tools.push({ id: finishedToolId, session_id: sessionId, turn_id: turnId, tool_name: 'search_assets',
    status: 'completed', result: { matches: 1 }, error: null, updated_at: new Date(now) })
  f.state.reservations.push({ id: externalReservationId, session_id: sessionId, turn_id: turnId,
    tool_call_id: externalToolId, status: 'reserved', settled_at: null })
  f.state.reservations.push({ id: modelReservationId, session_id: sessionId, turn_id: turnId,
    tool_call_id: null, status: 'reserved', settled_at: null })
  f.state.reservations.push({ id: finishedReservationId, session_id: sessionId, turn_id: turnId,
    tool_call_id: finishedToolId, status: 'reserved', settled_at: null })

  assert.deepEqual(await f.repo.expireDeadlines(10), { kind: 'deadline', processed: 1, remaining: false })
  assert.equal(t.status, 'failed'); assert.equal(t.revision, '6'); assert.equal(t.terminal_at?.getTime(), now)
  assert.deepEqual(t.error, DEADLINE_ERROR); assert.equal(t.lease_owner, null); assert.equal(t.lease_until, null)
  assert.equal(t.updated_at.getTime(), now)
  assert.equal(f.state.approvals[0]!.status, 'expired'); assert.equal(f.state.approvals[0]!.resolved_at?.getTime(), now)
  assert.equal(f.state.approvals[0]!.decision_revision, '6')
  assert.equal(f.state.tools[0]!.status, 'failed'); assert.deepEqual(f.state.tools[0]!.error, DEADLINE_ERROR)
  assert.equal(f.state.tools[1]!.status, 'waiting_external'); assert.deepEqual(f.state.tools[1]!.result, { assetId: 'asset-1' })
  assert.equal(f.state.tools[2]!.status, 'completed'); assert.deepEqual(f.state.tools[2]!.result, { matches: 1 })
  assert.equal(f.state.reservations[0]!.status, 'released'); assert.equal(f.state.reservations[0]!.settled_at?.getTime(), now)
  assert.equal(f.state.reservations[1]!.status, 'reserved'); assert.equal(f.state.reservations[1]!.settled_at, null)
  assert.equal(f.state.reservations[2]!.status, 'released'); assert.equal(f.state.reservations[2]!.settled_at?.getTime(), now)
  assert.equal(f.state.reservations[3]!.status, 'released'); assert.equal(f.state.reservations[3]!.settled_at?.getTime(), now)
  assert.equal(f.state.sessions[0]!.active_turn_id, null)
  assert.equal(f.state.events.length, 4)
  assert.deepEqual(f.state.events[1], { session_id: sessionId, turn_id: turnId, cursor: '2', entity_revision: '6',
    event_type: 'tool.updated', payload: { tool: { id: toolId, turnId, toolName: 'generate_image', status: 'failed', revision: '6' } } })
  assert.deepEqual(f.state.events[3], { session_id: sessionId, turn_id: turnId, cursor: '4', entity_revision: '6',
    event_type: 'turn.updated', payload: turnEvent(t) })
  assert.equal(f.state.outbox.length, 0)
  const selection = f.calls[0]!.sql
  assert.match(selection, /status IN \('queued','running','waiting_tools','waiting_approval'\)/)
  assert.match(selection, /deadline_at<=clock_timestamp\(\) ORDER BY t.deadline_at,t.id LIMIT \$1$/)
  assert.doesNotMatch(selection, /FOR UPDATE/)
  assert.match(f.calls[1]!.sql, /FROM agent_sessions WHERE id=\$1 FOR UPDATE SKIP LOCKED$/)
  assert.match(f.calls[2]!.sql, /FROM agent_turns WHERE id=\$1 AND session_id=\$2 .*FOR UPDATE SKIP LOCKED$/)
  const terminal = f.calls.find(c => c.sql.startsWith("UPDATE agent_turns SET status='failed'"))!.sql
  assert.match(terminal, /status='failed',terminal_at=clock_timestamp\(\),error=\$3::jsonb/)
  assert.match(terminal, /lease_owner=NULL,lease_until=NULL,revision=revision\+1/)
  const reservations = f.calls.find(c => c.sql.startsWith('UPDATE agent_budget_reservations r SET'))!.sql
  assert.match(reservations, /r.tool_call_id IS NULL AND r.round_id IS NULL/)
  assert.match(reservations, /x.status IN \('completed','failed','cancelled','skipped'\)/)
  assert.equal(f.commits, 1)
})

test('agent-recovery: deadline sweep fails and pairs a link-less waiting_external row while a linked one keeps waiting', async () => {
  const f = fixture()
  f.state.turns[0]!.deadline_at = new Date(now - 1)
  f.state.approvals = []
  f.state.tools = [
    { id: externalToolId, session_id: sessionId, turn_id: turnId, tool_name: 'generate_video', status: 'waiting_external',
      result: null, error: null, updated_at: new Date(now) },
    { id: otherToolId, session_id: sessionId, turn_id: turnId, tool_name: 'generate_image', status: 'waiting_external',
      result: { assetId: 'asset-1' }, error: null, updated_at: new Date(now) },
  ]
  f.state.links.push({ tool_call_id: otherToolId, session_id: sessionId, turn_id: turnId, media_job_id: 'job-1' })
  assert.deepEqual(await f.repo.expireDeadlines(10), { kind: 'deadline', processed: 1, remaining: false })
  const orphan = f.state.tools.find(tool => tool.id === externalToolId)!
  assert.equal(orphan.status, 'failed'); assert.deepEqual(orphan.error, UNOBSERVED_MEDIA_ERROR)
  const linked = f.state.tools.find(tool => tool.id === otherToolId)!
  assert.equal(linked.status, 'waiting_external'); assert.deepEqual(linked.result, { assetId: 'asset-1' })
  assert.equal(linked.error, null)
  const orphanItems = f.state.items.filter(item => item.tool_call_id === externalToolId)
  assert.equal(orphanItems.length, 1)
  assert.deepEqual(orphanItems[0]!.payload, { content: JSON.stringify(UNOBSERVED_MEDIA_ERROR), status: 'failed',
    result: null, error: UNOBSERVED_MEDIA_ERROR })
  assert.equal(f.state.items.filter(item => item.tool_call_id === otherToolId).length, 0)
  assert.deepEqual(f.state.events.filter(event => event.event_type === 'tool.updated').map(event => event.payload.tool),
    [{ id: externalToolId, turnId, toolName: 'generate_video', status: 'failed', revision: '3' }])
  const sweep = f.calls.find(call => call.sql.startsWith("UPDATE agent_tool_calls x SET status='failed',error=$3::jsonb"))!
  assert.match(sweep.sql, /x\.status='waiting_external'/)
  assert.match(sweep.sql, /NOT EXISTS \(SELECT 1 FROM agent_tool_job_links l WHERE l\.tool_call_id=x\.id/)
  assert.match(sweep.sql, /RETURNING x\.\*$/)
  assert.deepEqual(sweep.args, [turnId, sessionId, JSON.stringify(UNOBSERVED_MEDIA_ERROR)])
  assert.equal(f.commits, 1)
})

for (const [name, mutate] of [
  ['future deadline', (t: TurnRow) => { t.deadline_at = new Date(now + 1) }],
  ['completed turn', (t: TurnRow) => { t.status = 'completed'; t.terminal_at = new Date(now) }],
  ['failed turn', (t: TurnRow) => { t.status = 'failed'; t.terminal_at = new Date(now) }],
  ['cancelled turn', (t: TurnRow) => { t.status = 'cancelled'; t.terminal_at = new Date(now) }],
] as [string, (t: TurnRow) => void][]) {
  test(`agent-recovery: deadline sweep ignores ${name}`, async () => {
    const f = fixture(); mutate(f.state.turns[0]!)
    const before = structuredClone(f.state)
    assert.deepEqual(await f.repo.expireDeadlines(10), { kind: 'deadline', processed: 0, remaining: false })
    assert.deepEqual(f.state, before); assert.equal(f.calls.length, 1); assert.equal(f.commits, 1)
  })
}

test('agent-recovery: deadline boundary is inclusive and limit/remaining follows fetched rows', async () => {
  const f = fixture(); f.state.turns[0]!.deadline_at = new Date(now)
  assert.deepEqual(await f.repo.expireDeadlines(1), { kind: 'deadline', processed: 1, remaining: true })
  assert.deepEqual(await f.repo.expireDeadlines(1), { kind: 'deadline', processed: 0, remaining: false })
  const g = fixture(); g.state.turns[0]!.deadline_at = new Date(now - 1)
  assert.deepEqual(await g.repo.expireDeadlines(2), { kind: 'deadline', processed: 1, remaining: false })
})

test('agent-recovery: approval expiry resumes only when no approval/tool/cancel gate remains and wakes once', async () => {
  const f = fixture()
  const t = f.state.turns[0]!
  t.status = 'waiting_approval'; t.revision = '5'; t.lease_owner = null; t.lease_until = null
  assert.deepEqual(await f.repo.expireApprovals(10), { kind: 'approval', processed: 1, remaining: false })
  assert.equal(t.status, 'queued'); assert.equal(t.revision, '7'); assert.equal(t.updated_at.getTime(), now)
  assert.equal(f.state.approvals[0]!.status, 'expired'); assert.equal(f.state.approvals[0]!.decision_revision, '6')
  assert.equal(f.state.approvals[0]!.resolved_at?.getTime(), now)
  assert.equal(f.state.tools[0]!.status, 'failed'); assert.deepEqual(f.state.tools[0]!.error, APPROVAL_ERROR)
  assert.equal(f.state.reservations[0]!.status, 'released'); assert.equal(f.state.reservations[0]!.settled_at?.getTime(), now)
  assert.deepEqual(f.state.events.map(e => [e.cursor, e.event_type, e.entity_revision]), [
    ['1','item.created','6'],['2','tool.updated','6'],['3','approval.required','6'],['4','turn.updated','6'],['5','turn.updated','7'],
  ])
  assert.deepEqual(f.state.events.find(e=>e.event_type==='tool.updated')!.payload, { tool: { id: toolId, turnId, toolName: 'generate_image', status: 'failed', revision: '6' } })
  assert.deepEqual(f.state.events[3]!.payload, turnEvent(t, { status: 'waiting_approval', revision: '6', error: null }))
  assert.deepEqual(f.state.events[4]!.payload, turnEvent(t))
  assert.equal(f.state.outbox.length, 1)
  assert.deepEqual(f.state.outbox[0], { event_type: 'agent.turn.wake', aggregate_id: turnId,
    payload: { schemaVersion: 1, sessionId, turnId, revision: '7' }, dedupe_key: `agent:${turnId}:7`,
    created_at: new Date(now), dispatched_at: null, quarantined_at: null })
  assert.ok(f.calls.some(c=>c.sql.includes("b.status IN ('reserved','unknown')")))
  assert.ok(f.calls.some(c=>c.sql.includes("i.item_type='tool_result'")))
  assert.equal(f.commits, 1)

  assert.deepEqual(await f.repo.expireApprovals(10), { kind: 'approval', processed: 0, remaining: false })
  assert.equal(f.state.outbox.length, 1); assert.equal(f.state.events.length, 5)
})

for (const [name, mutate] of [
  ['active tool', (f: Fixture) => { f.state.tools.push({ id: otherToolId, session_id: sessionId, turn_id: turnId,
    tool_name: 'search_assets', status: 'executing', result: null, error: null, updated_at: new Date(now) }) }],
  ['pending approval', (f: Fixture) => { f.state.approvals.push({ id: otherApprovalId, session_id: sessionId, turn_id: turnId,
    tool_call_id: otherToolId, reservation_id: reservationId, status: 'pending', expires_at: new Date(now + 60000),
    resolved_at: null, decision_revision: null }) }],
  ['cancel intent', (f: Fixture) => { f.state.turns[0]!.cancel_requested_at = new Date(now - 1) }],
  ['running turn', (f: Fixture) => { f.state.turns[0]!.status = 'running' }],
] as [string, (f: Fixture) => void][]) {
  test(`agent-recovery: approval expiry does not queue/wake when ${name} blocks resumption`, async () => {
    const f = fixture()
    const t = f.state.turns[0]!
    t.status = 'waiting_approval'; t.revision = '5'; t.lease_owner = null; t.lease_until = null
    mutate(f)
    assert.deepEqual(await f.repo.expireApprovals(10), { kind: 'approval', processed: 1, remaining: false })
    assert.equal(t.status, name === 'running turn' ? 'running' : 'waiting_approval'); assert.equal(t.revision, '6')
    assert.equal(f.state.outbox.length, 0); assert.equal(f.state.events.length, 4)
    assert.equal(f.state.approvals[0]!.status, 'expired'); assert.equal(f.state.approvals[0]!.decision_revision, '6')
    assert.equal(f.state.tools[0]!.status, 'failed')
  })
}

test('agent-recovery: approval wake dedupe conflicts do not duplicate outbox rows', async () => {
  const f = fixture()
  const t = f.state.turns[0]!
  t.status = 'waiting_approval'; t.revision = '5'; t.lease_owner = null; t.lease_until = null
  f.state.outbox.push({ event_type: 'agent.turn.wake', aggregate_id: turnId,
    payload: { schemaVersion: 1, sessionId, turnId, revision: '7' }, dedupe_key: `agent:${turnId}:7`,
    created_at: new Date(now - 1), dispatched_at: null, quarantined_at: null })
  assert.equal((await f.repo.expireApprovals(10)).processed, 1)
  assert.equal(t.status, 'queued'); assert.equal(f.state.outbox.length, 1)
})

for (const [name, mutate] of [
  ['future approval', (f: Fixture) => { f.state.approvals[0]!.expires_at = new Date(now + 1) }],
  ['resolved approval', (f: Fixture) => { f.state.approvals[0]!.status = 'expired'; f.state.approvals[0]!.resolved_at = new Date(now) }],
  ['terminal turn', (f: Fixture) => { f.state.turns[0]!.status = 'completed'; f.state.turns[0]!.terminal_at = new Date(now) }],
] as [string, (f: Fixture) => void][]) {
  test(`agent-recovery: approval sweep ignores ${name}`, async () => {
    const f = fixture(); mutate(f)
    const before = structuredClone(f.state)
    assert.deepEqual(await f.repo.expireApprovals(10), { kind: 'approval', processed: 0, remaining: false })
    assert.deepEqual(f.state, before)
    assert.doesNotMatch(f.calls[0]!.sql, /FOR UPDATE/)
    assert.equal(f.calls[0]!.sql.includes('FROM agent_approvals a'), true)
  })
}

test('agent-recovery: cancellation finalization cancels local work but preserves waiting-external results and reservations', async () => {
  const f = fixture()
  const t = f.state.turns[0]!
  t.revision = '5'; t.cancel_requested_at = new Date(now - 100); t.lease_owner = null; t.lease_until = null
  f.state.tools[0]!.status = 'executing'; f.state.tools[0]!.result = { partial: true }
  f.state.tools.push({ id: externalToolId, session_id: sessionId, turn_id: turnId, tool_name: 'generate_video',
    status: 'waiting_external', result: { assetId: 'asset-1' }, error: { code: 'SUBMISSION_UNKNOWN', message: 'pending', retryable: false },
    updated_at: new Date(now) })
  f.state.links.push({ tool_call_id: externalToolId, session_id: sessionId, turn_id: turnId, media_job_id: 'job-external' })
  f.state.reservations.push({ id: externalReservationId, session_id: sessionId, turn_id: turnId,
    tool_call_id: externalToolId, status: 'reserved', settled_at: null })
  f.state.reservations.push({ id: modelReservationId, session_id: sessionId, turn_id: turnId,
    tool_call_id: null, status: 'reserved', settled_at: null })

  assert.deepEqual(await f.repo.finalizeCancellations(10), { kind: 'cancel', processed: 1, remaining: false })
  assert.equal(t.status, 'cancelled'); assert.equal(t.revision, '6'); assert.equal(t.terminal_at?.getTime(), now)
  assert.equal(t.lease_owner, null); assert.equal(t.lease_until, null); assert.equal(t.error, null)
  assert.equal(f.state.sessions[0]!.active_turn_id, null)
  assert.equal(f.state.approvals[0]!.status, 'expired'); assert.equal(f.state.approvals[0]!.decision_revision, '6')
  assert.equal(f.state.tools[0]!.status, 'cancelled'); assert.deepEqual(f.state.tools[0]!.error,{code:'TOOL_FAILED',message:'Agent tool cancelled',retryable:false})
  assert.deepEqual(f.state.tools[0]!.result, { partial: true })
  assert.equal(f.state.tools[1]!.status, 'waiting_external')
  assert.deepEqual(f.state.tools[1]!.result, { assetId: 'asset-1' })
  assert.deepEqual(f.state.tools[1]!.error, { code: 'SUBMISSION_UNKNOWN', message: 'pending', retryable: false })
  assert.equal(f.state.reservations[0]!.status, 'released'); assert.equal(f.state.reservations[0]!.settled_at?.getTime(), now)
  assert.equal(f.state.reservations[1]!.status, 'reserved'); assert.equal(f.state.reservations[1]!.settled_at, null)
  assert.equal(f.state.reservations[2]!.status, 'released'); assert.equal(f.state.reservations[2]!.settled_at?.getTime(), now)
  assert.deepEqual(f.state.events.map(e => [e.event_type, e.entity_revision]), [['item.created','6'],['tool.updated','6'],['approval.required','6'],['turn.updated','6']])
  assert.deepEqual(f.state.events.find(e=>e.event_type==='tool.updated')!.payload, { tool: { id: toolId, turnId, toolName: 'generate_image', status: 'cancelled', revision: '6' } })
  assert.equal(f.state.outbox.length, 0)
  const selection = f.calls[0]!.sql
  assert.match(selection, /cancel_requested_at IS NOT NULL AND \(t.lease_owner IS NULL OR t.lease_until<=clock_timestamp\(\)\)/)
  assert.match(selection, /ORDER BY t.cancel_requested_at,t.id LIMIT \$1$/)
  assert.doesNotMatch(selection, /FOR UPDATE/)
  assert.match(f.calls[1]!.sql, /FROM agent_sessions WHERE id=\$1 FOR UPDATE SKIP LOCKED$/)
  assert.match(f.calls[2]!.sql, /FROM agent_turns WHERE id=\$1 AND session_id=\$2 .*FOR UPDATE SKIP LOCKED$/)
  const reservations = f.calls.find(c => c.sql.startsWith('UPDATE agent_budget_reservations r SET'))!.sql
  assert.match(reservations, /r.tool_call_id IS NULL AND r.round_id IS NULL/)
  assert.match(reservations, /x.status IN \('completed','failed','cancelled','skipped'\)/)
  assert.deepEqual(await f.repo.finalizeCancellations(10), { kind: 'cancel', processed: 0, remaining: false })
  assert.equal(f.commits, 2)
})

test('agent-recovery: cancellation sweep fails and pairs a link-less waiting_external row while a linked one keeps waiting', async () => {
  const f = fixture()
  const t = f.state.turns[0]!
  t.cancel_requested_at = new Date(now - 100); t.lease_owner = null; t.lease_until = null
  f.state.approvals = []
  f.state.tools = [
    { id: externalToolId, session_id: sessionId, turn_id: turnId, tool_name: 'generate_video', status: 'waiting_external',
      result: null, error: null, updated_at: new Date(now) },
    { id: otherToolId, session_id: sessionId, turn_id: turnId, tool_name: 'generate_image', status: 'waiting_external',
      result: { assetId: 'asset-1' }, error: { code: 'SUBMISSION_UNKNOWN', message: 'pending', retryable: false },
      updated_at: new Date(now) },
  ]
  f.state.links.push({ tool_call_id: otherToolId, session_id: sessionId, turn_id: turnId, media_job_id: 'job-1' })
  assert.deepEqual(await f.repo.finalizeCancellations(10), { kind: 'cancel', processed: 1, remaining: false })
  assert.equal(t.status, 'cancelled')
  const orphan = f.state.tools.find(tool => tool.id === externalToolId)!
  assert.equal(orphan.status, 'failed'); assert.deepEqual(orphan.error, UNOBSERVED_MEDIA_ERROR)
  const linked = f.state.tools.find(tool => tool.id === otherToolId)!
  assert.equal(linked.status, 'waiting_external'); assert.deepEqual(linked.result, { assetId: 'asset-1' })
  assert.deepEqual(linked.error, { code: 'SUBMISSION_UNKNOWN', message: 'pending', retryable: false })
  assert.equal(f.state.items.filter(item => item.tool_call_id === externalToolId).length, 1)
  assert.equal(f.state.items.filter(item => item.tool_call_id === otherToolId).length, 0)
  assert.deepEqual(f.state.events.filter(event => event.event_type === 'tool.updated').map(event => event.payload.tool),
    [{ id: externalToolId, turnId, toolName: 'generate_video', status: 'failed', revision: '3' }])
  assert.equal(f.commits, 1)
})

for (const [name, mutate] of [
  ['active lease', (t: TurnRow) => { t.lease_owner = 'worker-a'; t.lease_until = new Date(now + 1) }],
  ['missing cancel intent', (t: TurnRow) => { t.cancel_requested_at = null }],
  ['terminal turn', (t: TurnRow) => { t.status = 'completed'; t.terminal_at = new Date(now) }],
] as [string, (t: TurnRow) => void][]) {
  test(`agent-recovery: cancellation finalization waits on ${name}`, async () => {
    const f = fixture(); const t = f.state.turns[0]!
    t.cancel_requested_at = new Date(now - 1); t.lease_owner = null; t.lease_until = null
    mutate(t)
    const before = structuredClone(f.state)
    assert.deepEqual(await f.repo.finalizeCancellations(10), { kind: 'cancel', processed: 0, remaining: false })
    assert.deepEqual(f.state, before); assert.equal(f.calls.length, 1)
  })
}

test('agent-recovery: cancellation finalization accepts lease boundary equality and queued turns without lease', async () => {
  const f = fixture(); const t = f.state.turns[0]!
  t.status = 'queued'; t.cancel_requested_at = new Date(now - 1); t.lease_owner = 'worker-a'; t.lease_until = new Date(now)
  assert.deepEqual(await f.repo.finalizeCancellations(10), { kind: 'cancel', processed: 1, remaining: false })
  assert.equal(t.status, 'cancelled')
})

test('agent-recovery: expired lease recovery clears private lease and re-emits a fencing-token-deduped wake', async () => {
  const f = fixture(); const t = f.state.turns[0]!
  t.revision = '4'; t.fencing_token = '9'; t.lease_owner = 'worker-a'; t.lease_until = new Date(now - 1)
  assert.deepEqual(await f.repo.recoverExpiredLeases(10), { kind: 'lease', processed: 1, remaining: false })
  assert.equal(t.lease_owner, null); assert.equal(t.lease_until, null); assert.equal(t.next_action_at?.getTime(), now)
  assert.equal(t.updated_at.getTime(), now); assert.equal(t.revision, '4'); assert.equal(t.fencing_token, '9')
  assert.equal(t.status, 'running')
  assert.deepEqual(f.state.events, [])
  assert.deepEqual(f.state.outbox, [{ event_type: 'agent.turn.wake', aggregate_id: turnId,
    payload: { schemaVersion: 1, sessionId, turnId, revision: '4' }, dedupe_key: `agent-recovery:lease:${turnId}:9`,
    created_at: new Date(now), dispatched_at: null, quarantined_at: null }])
  const selection = f.calls[0]!.sql
  assert.match(selection, /status='running' AND lease_owner IS NOT NULL AND lease_until<=clock_timestamp\(\)/)
  assert.match(selection, /deadline_at>clock_timestamp\(\) AND cancel_requested_at IS NULL/)
  assert.match(selection, /ORDER BY lease_until,id LIMIT \$1$/)
  assert.doesNotMatch(selection, /FOR UPDATE/)
  assert.match(f.calls[1]!.sql, /FROM agent_sessions WHERE id=\$1 FOR UPDATE SKIP LOCKED$/)
  assert.match(f.calls[2]!.sql, /FROM agent_turns WHERE id=\$1 AND session_id=\$2 .*FOR UPDATE SKIP LOCKED$/)
  const cleanup = f.calls.find(c => c.sql.startsWith('UPDATE agent_turns SET lease_owner=NULL'))!.sql
  assert.doesNotMatch(cleanup.split(' WHERE ')[0]!, /revision=|fencing_token=|status=/)

  t.lease_owner = 'worker-b'; t.lease_until = new Date(now - 1); t.fencing_token = '10'
  assert.equal((await f.repo.recoverExpiredLeases(10)).processed, 1)
  assert.equal(f.state.outbox.length, 2)
  assert.equal(f.state.outbox[1]!.dedupe_key, `agent-recovery:lease:${turnId}:10`)
  assert.deepEqual(f.state.outbox[1]!.payload, { schemaVersion: 1, sessionId, turnId, revision: '4' })
  assert.equal(f.commits, 2)
})

for (const [name, mutate] of [
  ['cancel intent', (t: TurnRow) => { t.cancel_requested_at = new Date(now - 1) }],
  ['expired deadline', (t: TurnRow) => { t.deadline_at = new Date(now) }],
  ['non-running turn', (t: TurnRow) => { t.status = 'waiting_tools' }],
  ['live lease', (t: TurnRow) => { t.lease_until = new Date(now + 1) }],
  ['no lease owner', (t: TurnRow) => { t.lease_owner = null; t.lease_until = null }],
] as [string, (t: TurnRow) => void][]) {
  test(`agent-recovery: lease recovery does not wake ${name}`, async () => {
    const f = fixture(); const t = f.state.turns[0]!
    t.lease_until = new Date(now - 1); mutate(t)
    const before = structuredClone(f.state)
    assert.deepEqual(await f.repo.recoverExpiredLeases(10), { kind: 'lease', processed: 0, remaining: false })
    assert.deepEqual(f.state, before); assert.equal(f.state.outbox.length, 0); assert.equal(f.calls.length, 1)
  })
}

test('agent-recovery: lease recovery limit/remaining follows fetched rows', async () => {
  const f = fixture(); f.state.turns[0]!.lease_until = new Date(now - 1)
  assert.deepEqual(await f.repo.recoverExpiredLeases(1), { kind: 'lease', processed: 1, remaining: true })
  const g = fixture(); g.state.turns[0]!.lease_until = new Date(now - 1)
  assert.deepEqual(await g.repo.recoverExpiredLeases(2), { kind: 'lease', processed: 1, remaining: false })
})

test('agent-recovery: outbox backlog counts only pending and quarantined rows and reports oldest pending age', async () => {
  const f = fixture()
  f.state.outbox.push(
    { event_type: 'x', aggregate_id: turnId, payload: {}, dedupe_key: 'a', created_at: new Date(now - 5000), dispatched_at: null, quarantined_at: null },
    { event_type: 'x', aggregate_id: turnId, payload: {}, dedupe_key: 'b', created_at: new Date(now - 2000), dispatched_at: null, quarantined_at: null },
    { event_type: 'x', aggregate_id: turnId, payload: {}, dedupe_key: 'c', created_at: new Date(now - 60000), dispatched_at: new Date(now), quarantined_at: null },
    { event_type: 'x', aggregate_id: turnId, payload: {}, dedupe_key: 'd', created_at: new Date(now - 10000), dispatched_at: null, quarantined_at: new Date(now) },
  )
  assert.deepEqual(await f.repo.outboxBacklog(), { pending: 2, oldestAgeMs: 5000, quarantined: 1 })
  assert.equal(f.calls.length, 1)
  assert.match(f.calls[0]!.sql, /clock_timestamp\(\)-MIN\(created_at\)/)
  assert.equal(f.commits, 1)
  assert.deepEqual(await fixture().repo.outboxBacklog(), { pending: 0, oldestAgeMs: null, quarantined: 0 })
})

test('agent-recovery: limits outside 1..1000 reject before opening a transaction', () => {
  const f = fixture()
  const methods = ['expireDeadlines', 'expireApprovals', 'finalizeCancellations', 'recoverExpiredLeases'] as const
  for (const limit of [0, -1, 1.5, NaN, Infinity, 1001]) {
    for (const method of methods) assert.throws(() => f.repo[method](limit), { code: 'INVALID_INPUT' })
  }
  assert.equal(f.calls.length, 0); assert.equal(f.commits, 0)
})

const rollbackCases: [string, (f: Fixture) => void, RegExp][] = [
  ['deadline', f => { f.state.turns[0]!.deadline_at = new Date(now - 1) }, /INSERT INTO agent_session_events/],
  ['approval', f => { const t = f.state.turns[0]!; t.status = 'waiting_approval'; t.revision = '5'; t.lease_owner = null; t.lease_until = null },
    /INSERT INTO agent_session_events/],
  ['cancellation', f => { const t = f.state.turns[0]!; t.cancel_requested_at = new Date(now - 1); t.lease_owner = null; t.lease_until = null },
    /INSERT INTO agent_session_events/],
  ['lease', f => { f.state.turns[0]!.lease_until = new Date(now - 1) }, /INSERT INTO outbox_events/],
]
for (const [name, setup, fail] of rollbackCases) {
  test(`agent-recovery: ${name} sweep rolls back all writes when SQL fails`, async () => {
    const f = fixture(); setup(f)
    const before = structuredClone(f.state)
    f.failOn(fail)
    const method = { deadline: 'expireDeadlines', approval: 'expireApprovals', cancellation: 'finalizeCancellations', lease: 'recoverExpiredLeases' }[name] as
      'expireDeadlines' | 'expireApprovals' | 'finalizeCancellations' | 'recoverExpiredLeases'
    await assert.rejects(f.repo[method](10), /injected SQL failure/)
    assert.deepEqual(f.state, before); assert.equal(f.rollbacks, 1); assert.equal(f.commits, 0)
  })
}

for (const reason of ['cancel','deadline'] as const) for (const status of ['recorded','running']) {
  test(`agent-recovery: ${reason} retains ${status} model intent as unknown with attributed usage and failed round`,async()=>{
    const f=fixture();const turn=f.state.turns[0]!
    if(reason==='deadline')turn.deadline_at=new Date(now);else{turn.cancel_requested_at=new Date(now);turn.lease_owner=null;turn.lease_until=null}
    f.state.rounds.push({id:'round-paid',status})
    for(const [index,quota] of ['model_calls','input_tokens','output_tokens'].entries())f.state.reservations.push({id:uuid(70+index),session_id:sessionId,turn_id:turnId,tool_call_id:null,round_id:'round-paid',quota,reserved_amount:quota==='model_calls'?'1':'100',status:'reserved',settled_at:null})
    if(reason==='deadline')await f.repo.expireDeadlines(10);else await f.repo.finalizeCancellations(10)
    assert.deepEqual(f.state.reservations.filter(r=>r.round_id).map(r=>r.status),['unknown','unknown','unknown']);assert.equal(f.state.rounds[0]!.status,'failed');assert.deepEqual(f.state.usages.map(u=>u.quota),['model_calls','input_tokens','output_tokens']);assert.ok(f.state.usages.every(u=>u.reason===`${reason}_model_outcome_unknown`))
    assert.equal(f.state.items.length,1);const item=f.state.items[0]!;const tool=f.state.tools[0]!;assert.equal(item.payload.content,JSON.stringify(tool.result??tool.error));assert.deepEqual(item.payload.error,tool.error)
    const decision=f.state.events.find(e=>e.event_type==='approval.required')!.payload.approval;assert.equal(decision.status,'expired');assert.equal(decision.revision,'3');assert.equal(decision.argumentsHash,'a'.repeat(64));assert.equal(decision.modelRevision,'language-revision');assert.equal(decision.resolvedBy,null);assert.equal(decision.resolvedAt,new Date(now).toISOString())
  })
}
test('agent-recovery: approval expiry atomically publishes result marker and full frozen decision summary',async()=>{
  const f=fixture();f.state.turns[0]!.status='waiting_approval';await f.repo.expireApprovals(10)
  const tool=f.state.tools[0]!;const item=f.state.items[0]!;assert.equal(item.tool_call_id,tool.id);assert.equal(item.payload.content,JSON.stringify(tool.error));assert.deepEqual(item.payload.error,tool.error)
  const decision=f.state.events.find(e=>e.event_type==='approval.required')!.payload.approval;assert.equal(decision.status,'expired');assert.equal(decision.revision,f.state.approvals[0]!.decision_revision);assert.equal(decision.pricingRevision,'price-v1');assert.equal(decision.reservationId,reservationId);assert.equal(decision.expiresAt,new Date(now-1).toISOString())
  const snapshot=structuredClone(f.state);await f.repo.expireApprovals(10);assert.deepEqual(f.state,snapshot)
})
