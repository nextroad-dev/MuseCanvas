import assert from 'node:assert/strict'
import test from 'node:test'
import { API_ENDPOINTS } from '../endpoints'
import type { AgentBudgetDTO, AgentDecimal, AgentEventEnvelope, AgentOutboxCommand, ToolExecutionResult } from './index'

test('Agent endpoint declarations encode IDs for registered handlers', () => {
  assert.equal('agent' in API_ENDPOINTS, true)
  assert.equal(API_ENDPOINTS.agent.sessions, '/api/agent/sessions')
  assert.equal(API_ENDPOINTS.agent.session('s/1'), '/api/agent/sessions/s%2F1')
  assert.equal(API_ENDPOINTS.agent.messages('s'), '/api/agent/sessions/s/messages')
  assert.equal(API_ENDPOINTS.agent.items('s'), '/api/agent/sessions/s/items')
  assert.equal(API_ENDPOINTS.agent.events('s'), '/api/agent/sessions/s/events')
  assert.equal(API_ENDPOINTS.agent.turn('t'), '/api/agent/turns/t')
  assert.equal(API_ENDPOINTS.agent.cancel('t'), '/api/agent/turns/t/cancel')
  assert.equal(API_ENDPOINTS.agent.steer('t'), '/api/agent/turns/t/steer')
  assert.equal(API_ENDPOINTS.agent.resolveApproval('a'), '/api/agent/approvals/a/resolve')
})

test('Agent wire bigint precision survives JSON and pending means durable jobs only', () => {
  const cursor: AgentDecimal = '9007199254740993'
  assert.equal(JSON.parse(JSON.stringify({ cursor })).cursor, cursor)
  const result: ToolExecutionResult = { kind: 'pending', jobIds: ['j'] }
  const command: AgentOutboxCommand = { type: 'agent.turn.wake', aggregateId: 't', payload: { schemaVersion: 1, sessionId: 's', turnId: 't', revision: cursor } }
  assert.equal(command.payload.schemaVersion, 1)
  assert.deepEqual(result.jobIds, ['j'])
  // @ts-expect-error PostgreSQL bigint cannot be represented by a number on the wire.
  const invalidCursor: AgentDecimal = 42
  void invalidCursor
  // @ts-expect-error A pending tool must identify at least one durable job.
  const emptyPending: ToolExecutionResult = { kind: 'pending', jobIds: [] }
  void emptyPending
  // @ts-expect-error Session display events are not queue commands.
  const displayCommand: AgentOutboxCommand['type'] = 'item.created'
  void displayCommand
  const eventTypes: AgentEventEnvelope['type'][] = ['item.created', 'tool.updated', 'approval.required', 'turn.updated']
  assert.equal(eventTypes.length, 4)
})

test('Agent budget protocol retains every independent policy limit and decimal cost precision', () => {
  const budget: AgentBudgetDTO = {
    maxModelCalls: 2, maxToolCalls: 4, maxMediaJobs: 3, maxMediaOutputs: 6,
    maxInputTokens: '9007199254740993', maxOutputTokens: '9007199254740994',
    maxEstimatedCost: { amount: '9007199254740993.000000001', currency: 'USD', pricingReference: 'pricing-1' },
    maxConcurrentMediaJobs: 2, deadlineAt: '2026-11-17T00:01:00Z',
  }
  assert.deepEqual(JSON.parse(JSON.stringify(budget)), budget)
  // @ts-expect-error Monetary amounts cannot be numbers on the wire.
  const invalidCost: AgentBudgetDTO['maxEstimatedCost'] = { amount: 0.1, currency: 'USD', pricingReference: 'pricing-1' }
  void invalidCost
})
