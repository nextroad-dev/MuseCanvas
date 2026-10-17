import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  appendUserMessage,
  applyAgentTimelineEvent,
  applyFailureMessage,
  applyPendingSnapshot,
  createAgentTimeline,
  describeApplyResult,
  hasActionablePending,
  mergeHistoryPage,
  planApplyRecovery,
  reduceAgentEvents,
  shouldApplyTurn,
  turnHasCanvasOps,
  unappliedOpsTurnIds,
} from './agent-turn-state.ts'

const event = (type, extra = {}) => ({ type, turnId: 't1', eventId: randomUUID(), ...extra })

function pending(id, extra = {}) {
  return {
    id,
    toolCallId: `call-${id}`,
    kind: 'image',
    prompt: 'a cat',
    modelId: 'model-1',
    parameters: {},
    sourceNodeId: null,
    sourceAssetId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    status: 'pending',
    jobId: null,
    ...extra,
  }
}

function message(extra) {
  return { id: randomUUID(), seq: 1, role: 'assistant', content: '', createdAt: 'now', ...extra }
}

test('live events produce ordered timeline items with grouped tool, ops and pending entries', () => {
  let state = appendUserMessage(createAgentTimeline(), { id: 'u1', text: 'draw a cat' })
  state = reduceAgentEvents([
    event('text_delta', { delta: 'planning' }),
    event('tool_call', { toolCall: { id: 'c1', name: 'generate_image', arguments: { prompt: 'cat' } } }),
    event('tool_result', { toolCallId: 'c1', success: true, result: { created: true } }),
    event('canvas_ops', { ops: [{ type: 'arrange', positions: [] }], baseRevision: 3 }),
    event('pending_jobs', { pendingJobs: [pending('p1')] }),
    event('done', {
      message: message({ id: 'm-final', seq: 9, content: 'done' }),
      usage: { inputTokens: 3, outputTokens: 4 },
      requireConfirmation: true,
      autoContinuationCount: 0,
    }),
  ], state)

  assert.deepEqual(state.items.map((item) => item.kind), ['user', 'assistant', 'tool', 'canvas_ops', 'pending', 'assistant'])
  const tool = state.items[2]
  assert.equal(tool.toolCallId, 'c1')
  assert.equal(tool.name, 'generate_image')
  assert.deepEqual(tool.result, { created: true })
  assert.equal(tool.success, true)
  const ops = state.items[3]
  assert.equal(ops.baseRevision, 3)
  assert.equal(ops.ops.length, 1)
  assert.equal(state.items[4].pending.id, 'p1')
})

test('a done event reconciles the persisted assistant message and drops the duplicate provisional segment', () => {
  let state = appendUserMessage(createAgentTimeline(), { id: 'u1', text: 'hi' })
  state = reduceAgentEvents([
    event('text_delta', { delta: 'hello there' }),
    event('done', {
      message: message({ id: 'm1', seq: 2, content: 'hello there' }),
      usage: { inputTokens: 1, outputTokens: 2 },
      requireConfirmation: true,
      autoContinuationCount: 0,
    }),
  ], state)

  const assistants = state.items.filter((item) => item.kind === 'assistant')
  assert.equal(assistants.length, 1)
  assert.equal(assistants[0].id, 'msg:m1')
  assert.equal(assistants[0].provisional, false)
  assert.equal(assistants[0].text, 'hello there')
})

test('merging the same history page twice is idempotent and older pages insert in seq order', () => {
  const latest = [
    message({ id: 'a2', seq: 2, content: 'second' }),
    message({ id: 'a3', seq: 3, content: 'third' }),
  ]
  let state = mergeHistoryPage(createAgentTimeline(), latest, [pending('p1')])
  state = mergeHistoryPage(state, latest, [pending('p1')])
  assert.equal(state.items.length, 3)
  assert.equal(state.items.filter((item) => item.kind === 'pending').length, 1)

  // Older page (lower seq) must land before the existing messages.
  state = mergeHistoryPage(state, [message({ id: 'a1', seq: 1, content: 'first' })], [])
  assert.deepEqual(state.items.map((item) => item.text ?? item.pending.id), ['first', 'second', 'third', 'p1'])
})

test('history tool calls and results group into one tool entry across pages', () => {
  const assistant = message({ id: 'a1', seq: 1, content: 'working', toolCalls: [{ id: 'call-9', name: 'edit_image', arguments: { selection: {} } }] })
  const tool = message({ id: 't1', seq: 2, role: 'tool', content: JSON.stringify({ toolCallId: 'call-9', success: false, result: { error: { code: 'NOPE' } } }) })
  let state = mergeHistoryPage(createAgentTimeline(), [assistant, tool])
  state = mergeHistoryPage(state, [assistant, tool])
  assert.equal(state.items.filter((item) => item.kind === 'tool').length, 1)
  const grouped = state.items.find((item) => item.kind === 'tool')
  assert.equal(grouped.name, 'edit_image')
  assert.equal(grouped.success, false)
})

test('pending proposals group by pending id and confirm snapshots update the same card', () => {
  let state = reduceAgentEvents([
    event('pending_jobs', { pendingJobs: [pending('p1'), pending('p2')] }),
    event('confirm_required', { pending: pending('p1', { status: 'pending' }) }),
  ])
  assert.equal(state.items.filter((item) => item.kind === 'pending').length, 2)

  state = applyPendingSnapshot(state, pending('p1', { status: 'submitted', jobId: 'job-1' }))
  assert.equal(state.items.filter((item) => item.kind === 'pending').length, 2)
  const card = state.items.find((item) => item.kind === 'pending' && item.pending.id === 'p1')
  assert.equal(card.pending.status, 'submitted')
  assert.equal(card.pending.jobId, 'job-1')
})

test('SSE eventId is not identity: distinct segments that reuse an eventId stay distinct', () => {
  const shared = { turnId: 't1', eventId: 'same-event-id' }
  const state = reduceAgentEvents([
    { type: 'text_delta', delta: 'first segment', ...shared },
    { type: 'text_delta', delta: 'second segment', ...shared },
  ])
  assert.deepEqual(state.items.map((item) => item.text), ['first segment', 'second segment'])
})

test('applyAgentTimelineEvent never mutates the input state', () => {
  const original = createAgentTimeline()
  const next = applyAgentTimelineEvent(original, event('text_delta', { delta: 'x' }))
  assert.equal(original.items.length, 0)
  assert.equal(next.items.length, 1)
})

test('apply-after-completion: only a turn with ops and no actionable pending is applied', () => {
  const opsEvent = event('canvas_ops', { ops: [{ type: 'arrange', positions: [] }], baseRevision: 2 })
  const doneEvent = () => event('done', {
    message: message({ id: 'm1', seq: 1, content: 'ok' }),
    usage: { inputTokens: 1, outputTokens: 1 },
    requireConfirmation: true,
    autoContinuationCount: 0,
  })

  // Ops produced and nothing waiting -> apply the turn.
  const completed = reduceAgentEvents([opsEvent, doneEvent()])
  assert.equal(turnHasCanvasOps(completed, 't1'), true)
  assert.equal(hasActionablePending(completed), false)
  assert.equal(shouldApplyTurn(completed, 't1'), true)

  // A pending that is still awaiting a decision freezes the revision: no apply.
  const withPending = reduceAgentEvents([opsEvent, event('pending_jobs', { pendingJobs: [pending('p1')] })]) 
  assert.equal(shouldApplyTurn(withPending, 't1'), false)
  assert.equal(hasActionablePending(withPending), true)

  // Once the proposal is decided (submitted), the same turn becomes applicable.
  const decided = applyPendingSnapshot(withPending, pending('p1', { status: 'submitted', jobId: 'job-1', turnId: 't1' }))
  assert.equal(hasActionablePending(decided), false)
  assert.equal(shouldApplyTurn(decided, 't1'), true)

  // Rejected resolves the same way.
  const rejected = applyPendingSnapshot(withPending, pending('p1', { status: 'rejected', turnId: 't1' }))
  assert.equal(shouldApplyTurn(rejected, 't1'), true)

  // A submitting pending blocks too.
  const submitting = reduceAgentEvents([event('pending_jobs', { pendingJobs: [pending('p1', { status: 'submitting' })] })])
  assert.equal(hasActionablePending(submitting), true)

  // A turn with no ops is never applied.
  const noOps = reduceAgentEvents([doneEvent()])
  assert.equal(shouldApplyTurn(noOps, 't1'), false)

  // A replay may carry ops on the persisted message instead of a canvas_ops event.
  const messageOps = reduceAgentEvents([event('pending_jobs', { pendingJobs: [pending('p1', { status: 'rejected' })] })])
  assert.equal(shouldApplyTurn(messageOps, 't1', 2), true)
})

test('apply feedback reports the real applied/revision/op count and the real failure reason', () => {
  assert.deepEqual(describeApplyResult({ applied: true, revision: 5, ops: [{ type: 'remove_node', nodeId: 'n' }, { type: 'remove_node', nodeId: 'm' }] }), {
    applied: true,
    revision: 5,
    opCount: 2,
    message: '已提交画布改动（版本 5，共 2 项）。',
  })
  assert.equal(describeApplyResult({ applied: false, revision: 6, ops: [] }).applied, false)

  assert.match(applyFailureMessage({ code: 'CANVAS_AGENT_APPLY_CONFLICT' }), /画布版本已变化/)
  assert.match(applyFailureMessage(new Error('boom')), /boom/)
  assert.match(applyFailureMessage(null), /失败/)
})

test('prepending an older page keeps tool and pending groupings intact across a re-merge', () => {
  const latest = [
    message({ id: 'a2', seq: 2, content: 'working', toolCalls: [{ id: 'call-7', name: 'generate_image', arguments: { prompt: 'cat' } }] }),
    message({ id: 't2', seq: 3, role: 'tool', content: JSON.stringify({ toolCallId: 'call-7', success: true, result: { jobId: 'job-7' } }) }),
  ]
  let state = mergeHistoryPage(createAgentTimeline(), latest, [pending('p1')])
  // Loading an older page shifts every later index...
  state = mergeHistoryPage(state, [message({ id: 'a1', seq: 1, content: 'first' })], [])
  // ...so re-merging the newest page must still update the same tool/pending entries.
  state = mergeHistoryPage(state, latest, [pending('p1', { status: 'submitted', jobId: 'job-7' })])
  const tools = state.items.filter((item) => item.kind === 'tool')
  const cards = state.items.filter((item) => item.kind === 'pending')
  assert.equal(tools.length, 1, 'one grouped tool entry, never a second or a corrupted one')
  assert.equal(tools[0].success, true)
  assert.deepEqual(tools[0].result, { jobId: 'job-7' })
  assert.equal(cards.length, 1, 'one pending card, updated in place')
  assert.equal(cards[0].pending.status, 'submitted')
  assert.deepEqual(state.items.map((item) => item.text ?? item.pending?.id ?? item.toolCallId), ['first', 'working', 'call-7', 'p1'])
})

test('a persisted assistant message with ops is applicable after reload without resending', () => {
  const persisted = message({ id: 'm-ops', seq: 4, turnId: 't1', content: '我建议调整画布', ops: [{ type: 'arrange', positions: [] }] })
  let state = mergeHistoryPage(createAgentTimeline(), [persisted], [])
  assert.equal(turnHasCanvasOps(state, 't1'), true, 'history-carried ops count as a proposal')
  assert.equal(shouldApplyTurn(state, 't1'), true, 'a recovered turn stays applyable after reload')
  state = mergeHistoryPage(state, [persisted], [])
  assert.equal(state.items.filter((item) => item.kind === 'assistant').length, 1, 're-merge is idempotent')
})

test('history-loaded recovery applies a completed unapplied ops turn once and never twice', () => {
  const persisted = message({ id: 'm-ops', seq: 4, turnId: 't1', content: '提案', ops: [{ type: 'arrange', positions: [] }] })
  const state = mergeHistoryPage(createAgentTimeline(), [persisted], [])
  assert.deepEqual(unappliedOpsTurnIds(state), ['t1'])

  // First history load: the turn has ops and nothing is actionable -> recover it.
  assert.equal(planApplyRecovery(state, new Set()), 't1')
  // The hook records every attempt, so a refetch that re-merges the page is inert.
  assert.equal(planApplyRecovery(state, new Set(['t1'])), null)
})

test('recovery never runs while a pending proposal is still actionable', () => {
  const opsEvent = event('canvas_ops', { ops: [{ type: 'arrange', positions: [] }], baseRevision: 2 })
  const withPending = reduceAgentEvents([opsEvent, event('pending_jobs', { pendingJobs: [pending('p1')] })])
  assert.equal(hasActionablePending(withPending), true)
  assert.equal(planApplyRecovery(withPending, new Set()), null)

  // Submitting is still actionable: applying would advance the revision under it.
  const submitting = reduceAgentEvents([opsEvent, event('pending_jobs', { pendingJobs: [pending('p1', { status: 'submitting' })] })])
  assert.equal(planApplyRecovery(submitting, new Set()), null)

  // Once the proposal is decided the same turn becomes recoverable.
  const decided = applyPendingSnapshot(withPending, pending('p1', { status: 'rejected', turnId: 't1' }))
  assert.equal(planApplyRecovery(decided, new Set()), 't1')
})

test('recovery is bounded: one newest un-attempted turn per call and no turn without ops', () => {
  // Two completed turns carrying ops; the newest is the only candidate returned.
  const older = message({ id: 'm-old', seq: 2, turnId: 't1', content: 'old', ops: [{ type: 'arrange', positions: [] }] })
  const newer = message({ id: 'm-new', seq: 4, turnId: 't2', content: 'new', ops: [{ type: 'arrange', positions: [] }] })
  const state = mergeHistoryPage(createAgentTimeline(), [older, newer], [])
  assert.deepEqual(unappliedOpsTurnIds(state), ['t1', 't2'])
  assert.equal(planApplyRecovery(state, new Set()), 't2')

  // A live canvas_ops event and the persisted message describing the same turn are
  // one candidate, not two.
  const live = reduceAgentEvents([
    event('canvas_ops', { ops: [{ type: 'arrange', positions: [] }], baseRevision: 1 }),
    event('done', { message: message({ id: 'm1', seq: 1, content: 'ok', turnId: 't1' }), usage: { inputTokens: 1, outputTokens: 1 }, requireConfirmation: true, autoContinuationCount: 0 }),
  ])
  const withHistory = mergeHistoryPage(live, [older], [])
  assert.deepEqual(unappliedOpsTurnIds(withHistory), ['t1'], 'same turn is de-duplicated across live and persisted forms')
  assert.equal(planApplyRecovery(withHistory, new Set(['t1'])), null)

  // A turn with no ops is never recovered.
  const noOps = reduceAgentEvents([event('done', { message: message({ id: 'm2', seq: 1, content: 'hi', turnId: 't9' }), usage: { inputTokens: 1, outputTokens: 1 }, requireConfirmation: true, autoContinuationCount: 0 })])
  assert.deepEqual(unappliedOpsTurnIds(noOps), [])
  assert.equal(planApplyRecovery(noOps, new Set()), null)
})
