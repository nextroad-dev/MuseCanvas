import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentBudgetDTO } from '@musecanvas/contracts'
import { areAgentMediaDependenciesTerminal, canReserveAgentBudget, canResumeAgentTurn, canTransitionAgentTurn, isTerminalAgentTurn, isAgentBudgetDeadlineExceeded, shouldSettleAgentCancellation, type AgentBudgetUsage } from './state-machine'

test('Agent turn transitions are explicit and terminal states never reopen', () => {
  assert.equal(canTransitionAgentTurn('queued', 'running'), true)
  assert.equal(canTransitionAgentTurn('running', 'waiting_tools'), true)
  assert.equal(canTransitionAgentTurn('waiting_tools', 'queued'), true)
  assert.equal(canTransitionAgentTurn('running', 'queued'), false)
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    assert.equal(isTerminalAgentTurn(status), true)
    assert.equal(canTransitionAgentTurn(status, 'queued'), false)
  }
})

test('resume waits for every tool result and approval gate; cancellation needs handoff and fence', () => {
  assert.equal(canResumeAgentTurn('waiting_tools', false, [{ status: 'completed', finalResultRecorded: true }, { status: 'waiting_external', finalResultRecorded: false }]), false)
  assert.equal(canResumeAgentTurn('waiting_approval', false, [{ status: 'failed', finalResultRecorded: true, approvalStatus: 'rejected' }]), true)
  assert.equal(canResumeAgentTurn('waiting_approval', false, [{ status: 'failed', finalResultRecorded: true, approvalStatus: 'pending' }]), false)
  assert.equal(canResumeAgentTurn('waiting_tools', true, []), false)
  assert.equal(canResumeAgentTurn('waiting_tools', false, []), false)
  assert.equal(shouldSettleAgentCancellation('running', true, true, false), false)
  assert.equal(shouldSettleAgentCancellation('running', true, true, true), true)
  assert.equal(shouldSettleAgentCancellation('cancelled', true, true, true), false)
})

test('multi-job completion requires all terminal dependencies', () => {
  assert.equal(areAgentMediaDependenciesTerminal(['succeeded', 'failed']), true)
  assert.equal(areAgentMediaDependenciesTerminal(['succeeded', 'running']), false)
  assert.equal(areAgentMediaDependenciesTerminal([]), false)
})

const now = Date.parse('2026-11-17T00:00:00Z')
const cost = (amount: string) => ({ amount, currency: 'USD', pricingReference: 'pricing-1' })
const usage = (overrides: Partial<AgentBudgetUsage> = {}): AgentBudgetUsage => ({
  modelCalls: 0, toolCalls: 0, mediaJobs: 0, mediaOutputs: 0, inputTokens: 0n, outputTokens: 0n, concurrentMediaJobs: 0, estimatedCost: cost('0'), ...overrides,
})
const limit = (overrides: Partial<AgentBudgetDTO> = {}): AgentBudgetDTO => ({
  maxModelCalls: 2, maxToolCalls: 4, maxMediaJobs: 3, maxMediaOutputs: 6, maxInputTokens: '100', maxOutputTokens: '50', maxEstimatedCost: cost('0.3'), maxConcurrentMediaJobs: 2, deadlineAt: '2026-11-17T00:01:00Z', ...overrides,
})

test('Agent budget independently bounds calls, jobs, outputs, split tokens and concurrent media', () => {
  const ceiling = limit()
  const exact = usage({ modelCalls: 2, toolCalls: 4, mediaJobs: 3, mediaOutputs: 6, inputTokens: 100n, outputTokens: 50n, concurrentMediaJobs: 2 })
  assert.equal(canReserveAgentBudget(usage(), exact, ceiling, now), true)
  for (const field of ['modelCalls', 'toolCalls', 'mediaJobs', 'mediaOutputs', 'concurrentMediaJobs'] as const) {
    assert.equal(canReserveAgentBudget(exact, usage({ [field]: 1 }), ceiling, now), false, field)
    assert.equal(canReserveAgentBudget(usage(), usage({ [field]: -1 }), ceiling, now), false, field)
    assert.equal(canReserveAgentBudget(usage(), usage({ [field]: 0.5 }), ceiling, now), false, field)
  }
  for (const field of ['inputTokens', 'outputTokens'] as const) {
    assert.equal(canReserveAgentBudget(exact, usage({ [field]: 1n }), ceiling, now), false, field)
    assert.equal(canReserveAgentBudget(usage(), usage({ [field]: -1n }), ceiling, now), false, field)
  }
  assert.equal(canReserveAgentBudget(usage(), usage(), limit({ maxInputTokens: '-1' }), now), false)
})

test('estimated cost uses exact decimal arithmetic at numeric(30,9) precision', () => {
  assert.equal(canReserveAgentBudget(usage({ estimatedCost: cost('0.1') }), usage({ estimatedCost: cost('0.2') }), limit(), now), true)
  assert.equal(canReserveAgentBudget(usage({ estimatedCost: cost('0.1') }), usage({ estimatedCost: cost('0.200000001') }), limit(), now), false)
  assert.equal(canReserveAgentBudget(usage({ estimatedCost: cost('9007199254740993.000000001') }), usage({ estimatedCost: cost('0.000000001') }), limit({ maxEstimatedCost: cost('9007199254740993.000000002') }), now), true)
  for (const amount of ['-1', 'NaN', '1e3', '0.0000000001', '1000000000000000000000', '01']) {
    assert.equal(canReserveAgentBudget(usage(), usage({ estimatedCost: cost(amount) }), limit(), now), false, amount)
  }
})

test('finite cost caps reject unknown usage, currency mismatch and stale pricing; explicit unlimited caps permit unknown cost', () => {
  assert.equal(canReserveAgentBudget(usage({ estimatedCost: null }), usage(), limit(), now), false)
  assert.equal(canReserveAgentBudget(usage(), usage({ estimatedCost: null }), limit(), now), false)
  assert.equal(canReserveAgentBudget(usage(), usage({ estimatedCost: { ...cost('0.1'), currency: 'EUR' } }), limit(), now), false)
  assert.equal(canReserveAgentBudget(usage(), usage({ estimatedCost: { ...cost('0.1'), pricingReference: 'pricing-2' } }), limit(), now), false)
  assert.equal(canReserveAgentBudget(usage({ estimatedCost: null }), usage({ estimatedCost: null }), limit({ maxEstimatedCost: null }), now), true)
})

test('Agent budgets fail closed at deadline and for invalid time/counter limits', () => {
  const ceiling = limit()
  assert.equal(isAgentBudgetDeadlineExceeded(ceiling.deadlineAt, now), false)
  assert.equal(isAgentBudgetDeadlineExceeded(ceiling.deadlineAt, Date.parse(ceiling.deadlineAt)), true)
  assert.equal(canReserveAgentBudget(usage(), usage(), ceiling, Date.parse(ceiling.deadlineAt)), false)
  assert.equal(canReserveAgentBudget(usage(), usage(), limit({ deadlineAt: 'invalid' }), now), false)
  assert.equal(canReserveAgentBudget(usage(), usage(), ceiling, NaN), false)
  assert.equal(canReserveAgentBudget(usage(), usage(), limit({ maxMediaOutputs: Infinity }), now), false)
})
