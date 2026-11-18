import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentConsoleScopeChanged,
  canReleaseScopedRequest,
  applyAgentEvent,
  applyAgentSnapshot,
  applyAgentTransportFrame,
  createEmptyAgentConsoleState,
  isTurnActive,
  prependOlderAgentItems,
} from './agent-console-state.ts'

const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'
const TURN_1 = '33333333-3333-4333-8333-333333333333'
const TURN_2 = '44444444-4444-4444-8444-444444444444'
const TOOL_1 = '55555555-5555-4555-8555-555555555555'
const APPROVAL_1 = '66666666-6666-4666-8666-666666666666'

function makeSession(id = SESSION_A, overrides = {}) {
  return {
    id,
    ownerId: 'owner-1',
    agentDefinitionId: 'def-1',
    definitionVersion: 1,
    defaultCanvasId: null,
    activeTurnId: null,
    inputRevision: '1',
    nextItemSequence: '2',
    nextEventCursor: '2',
    createdAt: '2026-11-17T08:00:00.000Z',
    updatedAt: '2026-11-17T08:00:00.000Z',
    archivedAt: null,
    ...overrides,
  }
}

function makeTurn(id = TURN_1, status = 'running', revision = '2', sessionId = SESSION_A) {
  return {
    id,
    sessionId,
    status,
    engineVersion: 'agent-core-v1',
    revision,
    inputRevision: '1',
    cancelRequestedAt: null,
    terminalAt: status === 'completed' || status === 'failed' || status === 'cancelled' ? '2026-11-17T08:01:00.000Z' : null,
    deadlineAt: '2026-11-17T08:05:00.000Z',
    error: null,
  }
}

function makeItem(id, sequence, type = 'user_message', content = 'msg', sessionId = SESSION_A) {
  return {
    id,
    sessionId,
    turnId: TURN_1,
    sequence,
    type,
    toolCallId: null,
    payload: { content },
    createdAt: '2026-11-17T08:00:00.000Z',
  }
}

function makeApproval(revision = '2', status = 'pending', sessionId = SESSION_A) {
  return {
    id: APPROVAL_1,
    sessionId,
    turnId: TURN_1,
    toolCallId: TOOL_1,
    argumentsHash: 'a'.repeat(64),
    modelRevision: '1',
    pricingRevision: '1',
    reservationId: 'res-1',
    status,
    expiresAt: '2026-11-17T08:10:00.000Z',
    resolvedBy: status === 'pending' ? null : 'owner-1',
    resolvedAt: status === 'pending' ? null : '2026-11-17T08:01:00.000Z',
    revision,
  }
}

test('stale A-to-B-to-A item-page completion cannot release the current scope lock', () => {
  const requestFromFirstA = 1
  const requestFromSecondA = 3
  const currentLockGeneration = requestFromSecondA
  assert.equal(canReleaseScopedRequest(currentLockGeneration, requestFromFirstA), false)
  assert.equal(canReleaseScopedRequest(currentLockGeneration, requestFromSecondA), true)
})
test('isTurnActive and agentConsoleScopeChanged classify states cleanly', () => {
  assert.equal(isTurnActive(null), false)
  assert.equal(isTurnActive(undefined), false)
  for (const active of ['queued', 'running', 'waiting_tools', 'waiting_approval']) {
    assert.equal(isTurnActive(makeTurn(TURN_1, active)), true)
  }
  for (const terminal of ['completed', 'failed', 'cancelled']) {
    assert.equal(isTurnActive(makeTurn(TURN_1, terminal)), false)
  }

  assert.equal(agentConsoleScopeChanged({ actorId: '', sessionId: null }, { actorId: undefined, sessionId: '' }), false)
  assert.equal(agentConsoleScopeChanged({ actorId: 'a', sessionId: SESSION_A }, { actorId: 'a', sessionId: SESSION_A }), false)
  assert.equal(agentConsoleScopeChanged({ actorId: 'a', sessionId: SESSION_A }, { actorId: 'b', sessionId: SESSION_A }), true)
  assert.equal(agentConsoleScopeChanged({ actorId: 'a', sessionId: SESSION_A }, { actorId: 'a', sessionId: SESSION_B }), true)
})

test('applyAgentSnapshot initializes, resets on session change, and clears resyncRequired', () => {
  let state = createEmptyAgentConsoleState()
  assert.equal(state.eventCursor, '0')
  assert.equal(state.resyncRequired, null)

  state = applyAgentSnapshot(state, {
    session: makeSession(SESSION_A, { activeTurnId: TURN_1 }),
    activeTurn: makeTurn(TURN_1, 'running', '2'),
    items: [makeItem('item-2', '10'), makeItem('item-1', '2')],
    eventCursor: '9007199254740993',
    lastItemSequence: '10',
    itemsHasMore: true,
    nextItemsCursor: '10',
    tools: [{ id: TOOL_1, turnId: TURN_1, toolName: 'generate_image', status: 'executing', revision: '2' }],
    approvals: [makeApproval('2', 'pending')],
    summariesTruncated: false,
  })

  assert.deepEqual(state.items.map((i) => i.sequence), ['2', '10'])
  assert.equal(state.eventCursor, '9007199254740993')
  assert.equal(state.tools[TOOL_1].status, 'executing')

  state = applyAgentTransportFrame(state, { type: 'resync.required', sessionId: SESSION_A, reason: 'retention' })
  assert.equal(state.resyncRequired, 'retention')

  state = applyAgentSnapshot(state, {
    session: makeSession(SESSION_A),
    activeTurn: null,
    items: [makeItem('item-1', '2')],
    eventCursor: '9007199254740995',
    lastItemSequence: '10',
    itemsHasMore: false,
    nextItemsCursor: '10',
    tools: [],
    approvals: [],
    summariesTruncated: false,
  })
  assert.equal(state.resyncRequired, null)
  assert.equal(state.eventCursor, '9007199254740995')

  state = applyAgentSnapshot(state, {
    session: makeSession(SESSION_B),
    activeTurn: null,
    items: [makeItem('item-b1', '1', 'user_message', 'hi', SESSION_B)],
    eventCursor: '1',
    lastItemSequence: '1',
    itemsHasMore: false,
    nextItemsCursor: '1',
    tools: [],
    approvals: [],
    summariesTruncated: false,
  })
  assert.equal(state.session.id, SESSION_B)
  assert.deepEqual(state.items.map((i) => i.id), ['item-b1'])
  assert.deepEqual(state.tools, {})
  assert.deepEqual(state.approvals, {})
})

test('prependOlderAgentItems deduplicates by id and sorts by BigInt sequence', () => {
  let state = applyAgentSnapshot(createEmptyAgentConsoleState(), {
    session: makeSession(SESSION_A),
    activeTurn: null,
    items: [makeItem('i-2', '9'), makeItem('i-big', '9007199254740994')],
    eventCursor: '5',
    lastItemSequence: '9007199254740994',
    itemsHasMore: true,
    nextItemsCursor: '9',
    tools: [],
    approvals: [],
    summariesTruncated: false,
  })

  state = prependOlderAgentItems(state, {
    items: [
      makeItem('i-2', '9'),
      makeItem('i-10', '10'),
      makeItem('i-big-prev', '9007199254740993'),
    ],
    nextCursor: '9007199254740993',
    hasMore: false,
    lastItemSequence: '9007199254740994',
  })

  assert.deepEqual(
    state.items.map((i) => i.sequence),
    ['9', '10', '9007199254740993', '9007199254740994'],
  )
  assert.equal(state.itemsHasMore, false)
  assert.equal(state.nextItemsCursor, '9007199254740993')
})

test('applyAgentEvent enforces monotonic BigInt revisions, deduplication, and session isolation', () => {
  let state = applyAgentSnapshot(createEmptyAgentConsoleState(), {
    session: makeSession(SESSION_A, { activeTurnId: TURN_1 }),
    activeTurn: makeTurn(TURN_1, 'waiting_approval', '9'),
    items: [makeItem('i-1', '1')],
    eventCursor: '4',
    lastItemSequence: '1',
    itemsHasMore: false,
    nextItemsCursor: '1',
    tools: [{ id: TOOL_1, turnId: TURN_1, toolName: 'generate_image', status: 'waiting_approval', revision: '9' }],
    approvals: [makeApproval('9', 'pending')],
    summariesTruncated: false,
  })
  assert.equal(state.approvals[APPROVAL_1].revision, '9')

  // Ignore foreign session events completely
  const afterForeign = applyAgentEvent(state, {
    schemaVersion: 1,
    eventId: 'ev-foreign',
    sessionId: SESSION_B,
    turnId: TURN_2,
    type: 'item.created',
    createdAt: '2026-11-17T08:00:05.000Z',
    cursor: '99',
    itemSequence: '99',
    entityRevision: '99',
    payload: { item: makeItem('foreign-item', '99', 'user_message', 'leak', SESSION_B) },
  })
  assert.equal(afterForeign, state)

  // Monotonic BigInt revision: '10' > '9' succeeds, stale '9' or '8' cannot regress '10'
  state = applyAgentEvent(state, {
    schemaVersion: 1,
    eventId: 'ev-5',
    sessionId: SESSION_A,
    turnId: TURN_1,
    type: 'approval.required',
    createdAt: '2026-11-17T08:00:05.000Z',
    cursor: '5',
    itemSequence: null,
    entityRevision: '10',
    payload: { approval: makeApproval('10', 'approved') },
  })
  assert.equal(state.approvals[APPROVAL_1].status, 'approved')
  assert.equal(state.approvals[APPROVAL_1].revision, '10')

  state = applyAgentEvent(state, {
    schemaVersion: 1,
    eventId: 'ev-stale-approval',
    sessionId: SESSION_A,
    turnId: TURN_1,
    type: 'approval.required',
    createdAt: '2026-11-17T08:00:04.000Z',
    cursor: '4',
    itemSequence: null,
    entityRevision: '9',
    payload: { approval: makeApproval('9', 'pending') },
  })
  assert.equal(state.approvals[APPROVAL_1].status, 'approved')

  // Equal revision does not regress non-pending approval back to pending
  state = applyAgentEvent(state, {
    schemaVersion: 1,
    eventId: 'ev-eq-approval',
    sessionId: SESSION_A,
    turnId: TURN_1,
    type: 'approval.required',
    createdAt: '2026-11-17T08:00:05.000Z',
    cursor: '5',
    itemSequence: null,
    entityRevision: '10',
    payload: { approval: makeApproval('10', 'pending') },
  })
  assert.equal(state.approvals[APPROVAL_1].status, 'approved')

  // Tool monotonic revision: '11' advances, '9' ignored
  state = applyAgentEvent(state, {
    schemaVersion: 1,
    eventId: 'ev-6',
    sessionId: SESSION_A,
    turnId: TURN_1,
    type: 'tool.updated',
    createdAt: '2026-11-17T08:00:06.000Z',
    cursor: '6',
    itemSequence: null,
    entityRevision: '11',
    payload: { tool: { id: TOOL_1, turnId: TURN_1, toolName: 'generate_image', status: 'completed', revision: '11' } },
  })
  assert.equal(state.tools[TOOL_1].status, 'completed')

  // Turn monotonic revision: '11' completed, '9' ignored, equal '11' running ignored
  state = applyAgentEvent(state, {
    schemaVersion: 1,
    eventId: 'ev-7',
    sessionId: SESSION_A,
    turnId: TURN_1,
    type: 'turn.updated',
    createdAt: '2026-11-17T08:00:07.000Z',
    cursor: '7',
    itemSequence: null,
    entityRevision: '11',
    payload: { turn: makeTurn(TURN_1, 'completed', '11') },
  })
  assert.equal(state.activeTurn.status, 'completed')
  assert.equal(state.session.activeTurnId, null)

  state = applyAgentEvent(state, {
    schemaVersion: 1,
    eventId: 'ev-stale-turn',
    sessionId: SESSION_A,
    turnId: TURN_1,
    type: 'turn.updated',
    createdAt: '2026-11-17T08:00:06.000Z',
    cursor: '6',
    itemSequence: null,
    entityRevision: '11',
    payload: { turn: makeTurn(TURN_1, 'running', '11') },
  })
  assert.equal(state.activeTurn.status, 'completed')

  // Item deduplication on replay
  state = applyAgentEvent(state, {
    schemaVersion: 1,
    eventId: 'ev-8',
    sessionId: SESSION_A,
    turnId: TURN_1,
    type: 'item.created',
    createdAt: '2026-11-17T08:00:08.000Z',
    cursor: '8',
    itemSequence: '1',
    entityRevision: null,
    payload: { item: makeItem('i-1', '1') },
  })
  assert.equal(state.items.length, 1)
  assert.equal(state.eventCursor, '8')
})

test('applyAgentTransportFrame does not advance cursor on ready, updates on heartbeat, flags resync', () => {
  let state = applyAgentSnapshot(createEmptyAgentConsoleState(), {
    session: makeSession(SESSION_A),
    activeTurn: null,
    items: [],
    eventCursor: '2',
    lastItemSequence: '0',
    itemsHasMore: false,
    nextItemsCursor: '0',
    tools: [],
    approvals: [],
    summariesTruncated: false,
  })

  state = applyAgentTransportFrame(state, { type: 'ready', sessionId: SESSION_A, highWater: '10' })
  assert.equal(state.eventCursor, '2')

  state = applyAgentTransportFrame(state, { type: 'heartbeat', sessionId: SESSION_A, cursor: '5' })
  assert.equal(state.eventCursor, '5')

  state = applyAgentTransportFrame(state, { type: 'heartbeat', sessionId: SESSION_A, cursor: '3' })
  assert.equal(state.eventCursor, '5')

  state = applyAgentTransportFrame(state, { type: 'resync.required', sessionId: SESSION_A, reason: 'backlog' })
  assert.equal(state.resyncRequired, 'backlog')

  const foreign = applyAgentTransportFrame(state, { type: 'resync.required', sessionId: SESSION_B, reason: 'unavailable' })
  assert.equal(foreign.resyncRequired, 'backlog')
})
