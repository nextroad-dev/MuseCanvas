import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentScopeChanged,
  appendUserMessage,
  applyAgentTimelineEvent,
  applyPendingSnapshot,
  beginConfirmation,
  classifyConfirmError,
  confirmationFailed,
  confirmationFor,
  confirmationSucceeded,
  createAgentTimeline,
  createConfirmationState,
  describeApplyResult,
  hasActionablePending,
  mergeHistoryPage,
  planApplyRecovery,
  resolveAgentAvailability,
  shouldApplyTurn,
  unappliedOpsTurnIds,
} from './agent-timeline.ts'

let eventCounter = 0
function baseEvent(type, turnId) {
  eventCounter += 1
  return { type, turnId, eventId: `${type}-${eventCounter}` }
}

function assistantMessage(id, seq, turnId, content, extra = {}) {
  return {
    id,
    seq,
    turnId,
    role: 'assistant',
    content,
    createdAt: '2026-10-22T10:00:00.000Z',
    ...extra,
  }
}

function pendingFixture(overrides = {}) {
  return {
    id: 'pending-1',
    toolCallId: 'call-1',
    kind: 'image',
    prompt: '清晨江边小镇',
    modelId: 'model-1',
    parameters: {},
    sourceNodeId: null,
    sourceAssetId: null,
    createdAt: '2026-10-22T10:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    status: 'pending',
    jobId: null,
    turnId: 'turn-1',
    ...overrides,
  }
}

function withOps() {
  const state = createAgentTimeline()
  return applyAgentTimelineEvent(state, {
    ...baseEvent('canvas_ops', 'turn-1'),
    ops: [{ type: 'remove_node', nodeId: 'node-1' }],
    baseRevision: 3,
  })
}

test('appendUserMessage 追加乐观用户消息', () => {
  const state = appendUserMessage(createAgentTimeline(), {
    id: 'msg-1',
    text: '来一张江边小镇',
    createdAt: '2026-10-22T09:41:00.000Z',
  })
  assert.equal(state.items.length, 1)
  assert.equal(state.items[0].kind, 'user')
  assert.equal(state.items[0].text, '来一张江边小镇')
  assert.equal(state.items[0].seq, null)
})

test('done 后丢弃同 turn 同文本的临时 delta 段落', () => {
  let state = createAgentTimeline()
  state = applyAgentTimelineEvent(state, { ...baseEvent('text_delta', 'turn-1'), delta: '好的，我整理了一版提示词。' })
  assert.equal(state.items.length, 1)
  assert.equal(state.items[0].provisional, true)

  state = applyAgentTimelineEvent(state, {
    ...baseEvent('done', 'turn-1'),
    message: assistantMessage('m1', 1, 'turn-1', '好的，我整理了一版提示词。'),
    usage: { inputTokens: 10, outputTokens: 5 },
    requireConfirmation: true,
    autoContinuationCount: 0,
  })
  assert.equal(state.items.length, 1)
  assert.equal(state.items[0].provisional, false)
  assert.equal(state.items[0].id, 'msg:m1')
  assert.equal(state.items[0].seq, 1)
})

test('history 合并幂等：重复合并同一页不产生重复项', () => {
  const messages = [
    { id: 'u1', seq: 1, turnId: 'turn-1', role: 'user', content: '画一只猫', createdAt: '' },
    assistantMessage('a1', 2, 'turn-1', '好的'),
  ]
  let state = mergeHistoryPage(createAgentTimeline(), messages, [pendingFixture()])
  state = mergeHistoryPage(state, messages, [pendingFixture()])
  assert.equal(state.items.filter((item) => item.kind === 'user').length, 1)
  assert.equal(state.items.filter((item) => item.kind === 'assistant').length, 1)
  assert.equal(state.items.filter((item) => item.kind === 'pending').length, 1)

  // 更旧的页（seq 更小）应插到最前。
  state = mergeHistoryPage(state, [
    { id: 'u0', seq: 0, turnId: 'turn-0', role: 'user', content: '更早的问题', createdAt: '' },
  ])
  assert.equal(state.items[0].id, 'msg:u0')
})

test('shouldApplyTurn：有 ops 且无未决提案才允许 apply', () => {
  let state = withOps()
  assert.equal(unappliedOpsTurnIds(state).length, 1)
  assert.equal(shouldApplyTurn(state, 'turn-1'), true)

  state = applyAgentTimelineEvent(state, {
    ...baseEvent('confirm_required', 'turn-1'),
    pending: pendingFixture(),
  })
  assert.equal(hasActionablePending(state), true)
  assert.equal(shouldApplyTurn(state, 'turn-1'), false)

  state = applyPendingSnapshot(state, pendingFixture({ status: 'submitted', jobId: 'job-1' }))
  assert.equal(hasActionablePending(state), false)
  assert.equal(shouldApplyTurn(state, 'turn-1'), true)
})

test('planApplyRecovery 只挑最新未尝试的 ops turn', () => {
  let state = withOps()
  state = applyAgentTimelineEvent(state, {
    ...baseEvent('canvas_ops', 'turn-2'),
    ops: [{ type: 'remove_node', nodeId: 'node-2' }],
    baseRevision: 4,
  })
  assert.equal(planApplyRecovery(state, new Set()), 'turn-2')
  assert.equal(planApplyRecovery(state, new Set(['turn-2'])), 'turn-1')
  assert.equal(planApplyRecovery(state, new Set(['turn-1', 'turn-2'])), null)
})

test('apply 结果描述包含版本与改动数', () => {
  assert.deepEqual(describeApplyResult({ applied: true, revision: 5, ops: [{ type: 'remove_node', nodeId: 'n' }] }), {
    applied: true,
    revision: 5,
    opCount: 1,
    message: '已提交画布改动（版本 5，共 1 项）。',
  })
  assert.equal(describeApplyResult({ applied: false, revision: 4, ops: [] }).applied, false)
})

test('提案确认状态机：提交中 → 成功/冲突', () => {
  let map = beginConfirmation(createConfirmationState(), 'pending-1', 'confirm')
  assert.equal(confirmationFor(map, 'pending-1').phase, 'submitting')

  map = confirmationSucceeded(map, { pending: pendingFixture({ status: 'submitted' }) })
  assert.equal(confirmationFor(map, 'pending-1').phase, 'submitted')

  const conflict = classifyConfirmError({ code: 'CANVAS_AGENT_CONFIRM_CONFLICT' })
  assert.equal(conflict.phase, 'conflict')
  assert.equal(conflict.requiresNewProposal, true)
  const failed = confirmationFailed(createConfirmationState(), 'pending-1', { code: 'CANVAS_AGENT_CONFIRM_EXPIRED' })
  assert.equal(failed['pending-1'].requiresNewProposal, true)
  assert.equal(failed['pending-1'].phase, 'expired')

  const generic = classifyConfirmError(new Error('网络错误'))
  assert.equal(generic.phase, 'error')
  assert.equal(generic.requiresNewProposal, false)
})

test('Agent 可用性：未配置/停用只说明原因，历史仍可用', () => {
  assert.equal(resolveAgentAvailability(undefined).canGenerate, false)
  assert.deepEqual(resolveAgentAvailability({
    enabled: true,
    available: true,
    reason: 'ready',
    maxToolCallsPerTurn: 1,
    maxJobsPerTurn: 1,
    timeoutMs: 1,
    maxAutoContinuations: 1,
  }), { canGenerate: true, notice: null, historyUsable: true })
  const disabled = resolveAgentAvailability({
    enabled: false,
    available: false,
    reason: 'disabled',
    maxToolCallsPerTurn: 1,
    maxJobsPerTurn: 1,
    timeoutMs: 1,
    maxAutoContinuations: 1,
  })
  assert.equal(disabled.canGenerate, false)
  assert.match(disabled.notice, /未启用/)
  assert.equal(disabled.historyUsable, true)
})

test('agentScopeChanged 把空串/null 都视为未登录', () => {
  assert.equal(agentScopeChanged('', null), false)
  assert.equal(agentScopeChanged(undefined, ''), false)
  assert.equal(agentScopeChanged('user-1', 'user-2'), true)
  assert.equal(agentScopeChanged('', 'user-1'), true)
})
