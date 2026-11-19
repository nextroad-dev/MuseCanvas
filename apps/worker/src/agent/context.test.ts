import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentDecimal, JsonObject } from '@musecanvas/contracts'
import {
  AgentContextError,
  assembleAgentContext,
  createAgentContext,
  type AgentContextCoverage,
  type AgentContextItem,
  type AgentContextRound,
  type AgentContextToolCall,
  type AgentContextTurn,
} from './context'

const sessionId = 'session-one'

type Fixture = {
  sessionId: string
  currentTurnId: string
  items: AgentContextItem[]
  rounds: AgentContextRound[]
  toolCalls: AgentContextToolCall[]
  turns: AgentContextTurn[]
  coverage: AgentContextCoverage
  maxBytes?: number
  maxTurns?: number
}

function item(sequence: number, turnId: string, type: AgentContextItem['type'], payload: JsonObject, toolCallId: string | null = null): AgentContextItem {
  return { id: `item-${sequence}`, sessionId, sequence: `${sequence}` as AgentDecimal, turnId, type, toolCallId, payload }
}

function user(sequence: number, turnId: string, content: string): AgentContextItem {
  return item(sequence, turnId, 'user_message', { content })
}
function assistant(sequence: number, turnId: string, content: string): AgentContextItem {
  return item(sequence, turnId, 'assistant_message', { content })
}
function callMarker(sequence: number, turnId: string, toolCallId: string): AgentContextItem {
  return item(sequence, turnId, 'tool_call', {}, toolCallId)
}
function resultMarker(sequence: number, turnId: string, toolCallId: string): AgentContextItem {
  return item(sequence, turnId, 'tool_result', {}, toolCallId)
}
function round(turnId: string, position: number, text: string, calls?: { id: string; name: string; arguments: JsonObject }[]): AgentContextRound {
  return { id: `${turnId}-round-${position}`, sessionId, turnId, position, status: 'completed', checkpoint: { text, toolCalls: calls ?? [] } }
}
function tool(input: {
  id: string
  turnId: string
  roundId: string
  position: number
  providerCallId: string
  name?: string
  arguments?: JsonObject
  result?: JsonObject | null
  status?: AgentContextToolCall['status']
}): AgentContextToolCall {
  return {
    id: input.id,
    sessionId,
    turnId: input.turnId,
    roundId: input.roundId,
    position: input.position,
    providerCallId: input.providerCallId,
    toolName: input.name ?? 'get_asset',
    toolSchemaVersion: 1,
    arguments: input.arguments ?? {},
    result: input.result === undefined ? { ok: true } : input.result,
    status: input.status ?? 'completed',
  }
}

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  const base: Fixture = {
    sessionId,
    currentTurnId: 'turn-2',
    turns: [
      { id: 'turn-1', sessionId, status: 'completed', terminalAt: '2026-11-17T08:00:00Z' },
      { id: 'turn-2', sessionId, status: 'running', terminalAt: null },
    ],
    coverage: { hasOlderItems: false, hasNewerItems: false },
    items: [
      user(1, 'turn-1', 'first'),
      assistant(2, 'turn-1', 'checking'),
      callMarker(3, 'turn-1', 'tool-a'),
      resultMarker(4, 'turn-1', 'tool-a'),
      assistant(5, 'turn-1', 'first done'),
      user(6, 'turn-2', 'second'),
      assistant(7, 'turn-2', 'working'),
      callMarker(8, 'turn-2', 'tool-b'),
      resultMarker(9, 'turn-2', 'tool-b'),
      callMarker(10, 'turn-2', 'tool-c'),
      resultMarker(11, 'turn-2', 'tool-c'),
      user(12, 'turn-2', 'steer after results'),
      assistant(13, 'turn-2', 'final'),
    ],
    rounds: [
      round('turn-1', 1, 'checking', [{ id: 'tool-a', name: 'get_asset__v1', arguments: { assetId: 'one' } }]),
      round('turn-1', 2, 'first done'),
      round('turn-2', 1, 'working', [
        { id: 'tool-b', name: 'get_asset__v1', arguments: { assetId: 'two' } },
        { id: 'tool-c', name: 'list_models__v1', arguments: { mode: 'text_to_image' } },
      ]),
      round('turn-2', 2, 'final'),
    ],
    toolCalls: [
      tool({ id: 'tool-a', turnId: 'turn-1', roundId: 'turn-1-round-1', position: 0, providerCallId: 'tool-a', arguments: { assetId: 'one' }, result: { nodes: 1 } }),
      tool({ id: 'tool-b', turnId: 'turn-2', roundId: 'turn-2-round-1', position: 0, providerCallId: 'tool-b', arguments: { assetId: 'two' }, result: { nodes: 2 } }),
      tool({ id: 'tool-c', turnId: 'turn-2', roundId: 'turn-2-round-1', position: 1, providerCallId: 'tool-c', name: 'list_models', arguments: { mode: 'text_to_image' }, result: { models: [] } }),
    ],
  }
  return { ...base, ...overrides }
}

function rejectsCode(fn: () => unknown, code: AgentContextError['code']) {
  assert.throws(fn, (error: unknown) => error instanceof AgentContextError && error.code === code)
}

test('agent context: preserves complete assistant tool-call order, one result per call and valid steering', () => {
  const assembly = assembleAgentContext(fixture())
  assert.deepEqual(assembly.messages.map(message => message.role), [
    'user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'tool', 'user', 'assistant',
  ])
  const firstRound = assembly.messages[1]!
  assert.equal(firstRound.role, 'assistant')
  assert.deepEqual(firstRound.role === 'assistant' ? firstRound.toolCalls?.map(call => call.id) : [], ['tool-a'])
  const lastToolRound = assembly.messages[5]!
  assert.deepEqual(lastToolRound.role === 'assistant' ? lastToolRound.toolCalls?.map(call => call.id) : [], ['tool-b', 'tool-c'])
  assert.deepEqual(assembly.messages.filter(message => message.role === 'tool').map(message => message.role === 'tool' ? message.toolCallId : ''), ['tool-a', 'tool-b', 'tool-c'])
  assert.equal(assembly.messages[8]!.role === 'user' && assembly.messages[8]!.content, 'steer after results')
  assert.deepEqual(assembly.diagnostics, {
    selectedTurns: 2, omittedTurns: 0, selectedItems: 13, omittedItems: 0, bytes: assembly.diagnostics.bytes,
    truncatedByTurns: false, truncatedByBytes: false, droppedLeadingPartialTurn: false, sourceWindowTruncated: false,
  })
})

test('agent context: private reasoning and unknown display payload fields never enter provider messages', () => {
  const input = fixture()
  input.rounds[0] = { ...input.rounds[0]!, checkpoint: { ...input.rounds[0]!.checkpoint!, reasoning: 'private chain of thought', thinking: 'hidden' } }
  input.items[1] = { ...input.items[1]!, payload: { content: 'checking', reasoning: 'private', analysis: 'hidden' } }
  const assembly = assembleAgentContext(input)
  const serialized = JSON.stringify(assembly.messages)
  assert.doesNotMatch(serialized, /private chain of thought|hidden|reasoning|analysis|thinking/)
})

test('agent context: steering inserted inside an assistant call/result pair is refused instead of reordered', () => {
  const input = fixture()
  input.items = [
    user(1, 'turn-2', 'go'),
    assistant(2, 'turn-2', 'call'),
    callMarker(3, 'turn-2', 'tool-a'),
    user(4, 'turn-2', 'steer during tools'),
    resultMarker(5, 'turn-2', 'tool-a'),
    assistant(6, 'turn-2', 'done'),
  ]
  input.currentTurnId = 'turn-2'
  input.rounds = [round('turn-2', 1, 'call', [{ id: 'tool-a', name: 'get_asset__v1', arguments: {} }]), round('turn-2', 2, 'done')]
  input.toolCalls = [tool({ id: 'tool-a', turnId: 'turn-2', roundId: 'turn-2-round-1', position: 0, providerCallId: 'tool-a' })]
  rejectsCode(() => assembleAgentContext(input), 'AGENT_CONTEXT_UNPAIRED')
})

test('agent context: missing, duplicate or unresolved tool results fail closed', () => {
  const missing = fixture()
  missing.items = missing.items.filter(entry => entry.id !== 'item-9').map((entry, index) => ({ ...entry, sequence: `${index + 1}` as AgentDecimal }))
  rejectsCode(() => assembleAgentContext(missing), 'AGENT_CONTEXT_UNPAIRED')

  const duplicate = fixture()
  duplicate.items = [...duplicate.items, resultMarker(14, 'turn-2', 'tool-b')].sort((a, b) => Number(a.sequence) - Number(b.sequence))
  rejectsCode(() => assembleAgentContext(duplicate), 'AGENT_CONTEXT_UNPAIRED')

  const pending = fixture()
  pending.toolCalls = pending.toolCalls.map(entry => entry.id === 'tool-b' ? { ...entry, status: 'executing', result: null } : entry)
  rejectsCode(() => assembleAgentContext(pending), 'AGENT_CONTEXT_UNPAIRED')

  const missingResultValue = fixture()
  missingResultValue.toolCalls = missingResultValue.toolCalls.map(entry => entry.id === 'tool-b' ? { ...entry, result: null } : entry)
  rejectsCode(() => assembleAgentContext(missingResultValue), 'AGENT_CONTEXT_UNPAIRED')
})

test('agent context: corrupt round, checkpoint and argument bindings are refused', () => {
  const running = fixture()
  running.rounds[2] = { ...running.rounds[2]!, status: 'running' }
  rejectsCode(() => assembleAgentContext(running), 'AGENT_CONTEXT_CORRUPT')

  const unknownStatus = fixture()
  unknownStatus.rounds[2] = { ...unknownStatus.rounds[2]!, status: 'mystery' as never }
  rejectsCode(() => assembleAgentContext(unknownStatus), 'AGENT_CONTEXT_UNKNOWN')

  const noCheckpoint = fixture()
  noCheckpoint.rounds[2] = { ...noCheckpoint.rounds[2]!, checkpoint: null }
  rejectsCode(() => assembleAgentContext(noCheckpoint), 'AGENT_CONTEXT_CORRUPT')

  const textMismatch = fixture()
  textMismatch.rounds[2] = { ...textMismatch.rounds[2]!, checkpoint: { ...textMismatch.rounds[2]!.checkpoint!, text: 'different' } }
  rejectsCode(() => assembleAgentContext(textMismatch), 'AGENT_CONTEXT_CORRUPT')

  const callMismatch = fixture()
  callMismatch.rounds[2] = round('turn-2', 1, 'working', [
    { id: 'tool-b', name: 'get_asset__v1', arguments: { assetId: 'changed' } },
    { id: 'tool-c', name: 'list_models__v1', arguments: { mode: 'text_to_image' } },
  ])
  rejectsCode(() => assembleAgentContext(callMismatch), 'AGENT_CONTEXT_CORRUPT')
})

test('agent context: unknown item/round/tool context and malformed sequences are refused', () => {
  const unknownItem = fixture()
  unknownItem.items[0] = { ...unknownItem.items[0]!, type: 'mystery' as never }
  rejectsCode(() => assembleAgentContext(unknownItem), 'AGENT_CONTEXT_UNKNOWN')

  const unknownToolStatus = fixture()
  unknownToolStatus.toolCalls[0] = { ...unknownToolStatus.toolCalls[0]!, status: 'mystery' as never }
  rejectsCode(() => assembleAgentContext(unknownToolStatus), 'AGENT_CONTEXT_UNKNOWN')

  const duplicateSequence = fixture()
  duplicateSequence.items[1] = { ...duplicateSequence.items[1]!, sequence: '1' }
  rejectsCode(() => assembleAgentContext(duplicateSequence), 'AGENT_CONTEXT_CORRUPT')

  const futureTurn = fixture()
  futureTurn.toolCalls[0] = { ...futureTurn.toolCalls[0]!, turnId: 'turn-unknown' }
  rejectsCode(() => assembleAgentContext(futureTurn), 'AGENT_CONTEXT_UNKNOWN')

  const wrongCurrent = fixture({ currentTurnId: 'turn-1' })
  rejectsCode(() => assembleAgentContext(wrongCurrent), 'AGENT_CONTEXT_INVALID')

  const startsAtAssistant = fixture()
  startsAtAssistant.items = startsAtAssistant.items.filter(entry => entry.id !== 'item-1')
  rejectsCode(() => assembleAgentContext(startsAtAssistant), 'AGENT_CONTEXT_TRUNCATED')
})

test('agent context: a page with newer Items is never treated as the complete session', () => {
  rejectsCode(() => assembleAgentContext(fixture({ coverage: { hasOlderItems: false, hasNewerItems: true } })), 'AGENT_CONTEXT_TRUNCATED')
})

test('agent context: any partial source window fails closed, including one starting at a steering user Item', () => {
  rejectsCode(() => assembleAgentContext(fixture({ coverage: { hasOlderItems: true, hasNewerItems: false } })), 'AGENT_CONTEXT_TRUNCATED')
  const input = fixture()
  input.items = input.items.filter(entry => entry.turnId === 'turn-2')
  rejectsCode(() => assembleAgentContext(input), 'AGENT_CONTEXT_TRUNCATED')
})

test('agent context: history caps select whole newest turns with explicit diagnostics', () => {
  const oneTurn = assembleAgentContext(fixture({ maxTurns: 1 }))
  assert.equal(oneTurn.diagnostics.selectedTurns, 1)
  assert.equal(oneTurn.diagnostics.omittedTurns, 1)
  assert.equal(oneTurn.diagnostics.truncatedByTurns, true)
  assert.equal(oneTurn.messages[0]!.role, 'user')
  assert.equal(oneTurn.messages[0]!.role === 'user' && oneTurn.messages[0]!.content, 'second')
  const toolRound = oneTurn.messages.find(message => message.role === 'assistant' && message.toolCalls?.length)
  assert.deepEqual(toolRound?.role === 'assistant' ? toolRound.toolCalls?.map(call => call.id) : [], ['tool-b', 'tool-c'])

  const tiny = assembleAgentContext(fixture({ maxBytes: 600 }))
  assert.equal(tiny.diagnostics.truncatedByBytes, true)
  assert.equal(tiny.diagnostics.selectedTurns, 1)
  assert.equal(tiny.messages[0]!.role, 'user')
  assert.equal(tiny.messages[0]!.role === 'user' && tiny.messages[0]!.content, 'second')

  rejectsCode(() => assembleAgentContext(fixture({ maxBytes: 40 })), 'AGENT_CONTEXT_TOO_LARGE')
})

test('agent context: NUL, unpaired surrogates and oversized content are refused with bounded UTF-8 errors', () => {
  const nul = fixture()
  nul.items[0] = user(1, 'turn-1', 'bad\0text')
  rejectsCode(() => assembleAgentContext(nul), 'AGENT_CONTEXT_INVALID')

  const surrogate = fixture()
  surrogate.items[0] = user(1, 'turn-1', '\uD800')
  rejectsCode(() => assembleAgentContext(surrogate), 'AGENT_CONTEXT_INVALID')

  const oversized = fixture()
  oversized.items[0] = user(1, 'turn-1', 'x'.repeat(32_001))
  rejectsCode(() => assembleAgentContext(oversized), 'AGENT_CONTEXT_TOO_LARGE')

  const tooMany = fixture()
  tooMany.items = Array.from({ length: 10_001 }, (_, index) => user(index + 1, `turn-${index + 1}`, 'x'))
  rejectsCode(() => assembleAgentContext(tooMany), 'AGENT_CONTEXT_TOO_LARGE')
})

test('agent context: invalid coverage or empty Items cannot be mistaken for complete history', () => {
  rejectsCode(() => assembleAgentContext({ ...fixture(), coverage: undefined as never }), 'AGENT_CONTEXT_INVALID')
  rejectsCode(() => assembleAgentContext({ ...fixture(), items: [] }), 'AGENT_CONTEXT_INVALID')
  rejectsCode(() => assembleAgentContext({ ...fixture(), maxTurns: 0 }), 'AGENT_CONTEXT_INVALID')
})

test('agent context: visible content blocks preserve text/tool interleaving and reject unknown or corrupt blocks', () => {
  const input = fixture()
  input.rounds[2] = { ...input.rounds[2]!, checkpoint: {
    ...input.rounds[2]!.checkpoint!, contentBlocks: [
      { type: 'tool_call', toolCall: { id: 'tool-b', name: 'get_asset__v1', arguments: { assetId: 'two' } } },
      { type: 'text', text: 'working' },
      { type: 'tool_call', toolCall: { id: 'tool-c', name: 'list_models__v1', arguments: { mode: 'text_to_image' } } },
    ],
  } }
  const assembled = assembleAgentContext(input)
  const message = assembled.messages[5]!
  assert.deepEqual(message.role === 'assistant' ? message.contentBlocks?.map(block => block.type) : [], ['tool_call', 'text', 'tool_call'])
  input.rounds[2] = { ...input.rounds[2]!, checkpoint: { ...input.rounds[2]!.checkpoint!, contentBlocks: [{ type: 'thinking', text: 'private' }] } }
  rejectsCode(() => assembleAgentContext(input), 'AGENT_CONTEXT_UNKNOWN')
})

test('agent context: session mismatch and missing sequence ranges are refused', () => {
  for (const key of ['items', 'rounds', 'toolCalls'] as const) {
    const input = fixture()
    input[key][0] = { ...input[key][0]!, sessionId: 'other-session' } as never
    rejectsCode(() => assembleAgentContext(input), 'AGENT_CONTEXT_INVALID')
  }
  const input = fixture()
  input.items = input.items.filter(entry => entry.sequence !== '4')
  rejectsCode(() => assembleAgentContext(input), 'AGENT_CONTEXT_TRUNCATED')
})

test('agent context: duplicate provider ids, reversed markers and checkpoint omissions fail closed', () => {
  const duplicate = fixture()
  duplicate.toolCalls[1] = { ...duplicate.toolCalls[1]!, providerCallId: 'tool-a' }
  rejectsCode(() => assembleAgentContext(duplicate), 'AGENT_CONTEXT_CORRUPT')

  const reversed = fixture()
  reversed.items[2] = resultMarker(3, 'turn-1', 'tool-a')
  reversed.items[3] = callMarker(4, 'turn-1', 'tool-a')
  rejectsCode(() => assembleAgentContext(reversed), 'AGENT_CONTEXT_UNPAIRED')

  const omitted = fixture()
  omitted.rounds[0] = { ...omitted.rounds[0]!, checkpoint: { text: 'checking' } }
  rejectsCode(() => assembleAgentContext(omitted), 'AGENT_CONTEXT_CORRUPT')

  const corruptResult = fixture()
  corruptResult.items[3] = { ...corruptResult.items[3]!, payload: { result: { secret: 'wrong-result' } } }
  assert.throws(() => assembleAgentContext(corruptResult), (error: unknown) => {
    assert.ok(error instanceof AgentContextError)
    assert.equal(error.code, 'AGENT_CONTEXT_CORRUPT')
    assert.doesNotMatch(String(error), /secret|wrong-result/)
    return true
  })
})

test('agent context: initial and steering-only input is valid, while incomplete historical turns are refused', () => {
  const input = fixture({ items: [user(1, 'turn-2', 'initial'), user(2, 'turn-2', 'steering')], rounds: [], toolCalls: [] })
  assert.deepEqual(assembleAgentContext(input).messages, [{ role: 'user', content: 'initial' }, { role: 'user', content: 'steering' }])
  const historical = fixture({ items: [user(1, 'turn-1', 'unfinished'), user(2, 'turn-2', 'current')], rounds: [], toolCalls: [] })
  rejectsCode(() => assembleAgentContext(historical), 'AGENT_CONTEXT_UNPAIRED')
})

test('agent context: frozen build factory reads raw owner-scoped complete rows and keeps the transaction free of provider calls', async () => {
  const scope = { ownerId: '20000000-0000-4000-8000-000000000001', sessionId: '20000000-0000-4000-8000-000000000002', turnId: '20000000-0000-4000-8000-000000000003' }
  const calls: string[] = []
  const raw = fixture({ currentTurnId: scope.turnId, sessionId: scope.sessionId,
    items: [user(1, scope.turnId, 'hello')], rounds: [], toolCalls: [] })
  let transactions = 0
  const port = createAgentContext({ transaction: async work => {
    transactions++
    return work({ query: async (sql, args) => {
      calls.push(sql)
      if (sql.includes('SELECT t.config_snapshot')) {
        assert.deepEqual(args, [scope.ownerId, scope.sessionId, scope.turnId])
        return { rows: [{ config_snapshot: { instructions: 'help' }, next_item_sequence: '2' }], rowCount: 1 }
      }
      if (sql.includes('SELECT t.id,t.session_id,t.status,t.terminal_at')) {
        assert.deepEqual(args, [scope.ownerId, scope.sessionId])
        return { rows: [{ id: scope.turnId, session_id: scope.sessionId, status: 'running', terminal_at: null }], rowCount: 1 }
      }
      assert.deepEqual(args, [scope.sessionId])
      if (sql.includes('FROM agent_items')) return { rows: raw.items.map(value => ({
        id: value.id, session_id: scope.sessionId, turn_id: value.turnId, sequence: value.sequence,
        item_type: value.type, tool_call_id: value.toolCallId, payload: value.payload,
      })), rowCount: 1 }
      return { rows: [], rowCount: 0 }
    } })
  } })
  const output = await port.build({ ...scope, instructions: 'help' })
  assert.deepEqual({ system: output.system, messages: output.messages }, { system: 'help', messages: [{ role: 'user', content: 'hello' }] })
  assert.equal(output.diagnostics.omittedTurns, 0)
  assert.equal(transactions, 1)
  assert.equal(calls.length, 5)
  assert.ok(calls.every(sql => !/INSERT|UPDATE|BEGIN|COMMIT|ROLLBACK/.test(sql)))
})

test('agent context: frozen factory refuses owner mismatch and sanitizes store failures', async () => {
  const scope = { ownerId: '20000000-0000-4000-8000-000000000001', sessionId: '20000000-0000-4000-8000-000000000002', turnId: '20000000-0000-4000-8000-000000000003', instructions: 'help' }
  const denied = createAgentContext({ transaction: async work => work({ query: async () => ({ rows: [], rowCount: 0 }) }) })
  await assert.rejects(denied.build(scope), (error: unknown) => error instanceof AgentContextError && error.code === 'AGENT_CONTEXT_INVALID')
  const broken = createAgentContext({ transaction: async () => { throw new Error('SQL prompt private key') } })
  await assert.rejects(broken.build(scope), (error: unknown) => {
    assert.ok(error instanceof AgentContextError)
    assert.equal(error.code, 'AGENT_CONTEXT_STORE_UNAVAILABLE')
    assert.doesNotMatch(String(error), /SQL|prompt|private|key/)
    return true
  })
})

test('agent context review P1: cancelled and failed user-only histories permit the next Turn without an invented reply', () => {
  for (const status of ['cancelled', 'failed'] as const) {
    const input = fixture({ items: [user(1, 'turn-1', 'never executed'), user(2, 'turn-2', 'next request')], rounds: [], toolCalls: [] })
    input.turns[0] = { ...input.turns[0]!, status }
    assert.deepEqual(assembleAgentContext(input).messages, [
      { role: 'user', content: 'never executed' }, { role: 'user', content: 'next request' },
    ])
    input.turns[0] = { ...input.turns[0]!, terminalAt: null }
    rejectsCode(() => assembleAgentContext(input), 'AGENT_CONTEXT_CORRUPT')
  }
})

test('agent context review P1: terminal histories still reject unresolved tool pairs', () => {
  const input = fixture()
  input.turns[0] = { ...input.turns[0]!, status: 'cancelled' }
  input.toolCalls[0] = { ...input.toolCalls[0]!, status: 'executing', result: null }
  rejectsCode(() => assembleAgentContext(input), 'AGENT_CONTEXT_UNPAIRED')
})

test('agent context review P1: factory loads queued-cancelled history and next Turn from one scoped snapshot', async () => {
  const scope = { ownerId: '20000000-0000-4000-8000-000000000001', sessionId: '20000000-0000-4000-8000-000000000002', turnId: '20000000-0000-4000-8000-000000000003' }
  const oldTurnId = '20000000-0000-4000-8000-000000000004'
  let transactions = 0
  const port = createAgentContext({ transaction: async work => {
    transactions++
    return work({ query: async (sql, args) => {
      if (sql.includes('SELECT t.config_snapshot')) {
        assert.deepEqual(args, [scope.ownerId, scope.sessionId, scope.turnId])
        return { rows: [{ config_snapshot: { instructions: 'help' }, next_item_sequence: '3' }], rowCount: 1 }
      }
      if (sql.includes('SELECT t.id,t.session_id,t.status,t.terminal_at')) {
        assert.deepEqual(args, [scope.ownerId, scope.sessionId])
        return { rows: [
          { id: oldTurnId, session_id: scope.sessionId, status: 'cancelled', terminal_at: new Date('2026-11-17T08:00:00Z') },
          { id: scope.turnId, session_id: scope.sessionId, status: 'running', terminal_at: null },
        ], rowCount: 2 }
      }
      if (sql.includes('FROM agent_items')) return { rows: [oldTurnId, scope.turnId].map((id, index) => ({
        id: `item-${index}`, session_id: scope.sessionId, turn_id: id, sequence: String(index + 1),
        item_type: 'user_message', tool_call_id: null, payload: { content: index === 0 ? 'cancelled request' : 'next request' },
      })), rowCount: 2 }
      return { rows: [], rowCount: 0 }
    } })
  } })
  const output = await port.build({ ...scope, instructions: 'help' })
  assert.deepEqual(output.messages, [{ role: 'user', content: 'cancelled request' }, { role: 'user', content: 'next request' }])
  assert.equal(transactions, 1)
})

test('agent context review P2: legitimate writer marker fields are checked against tool rows', () => {
  const input = fixture()
  input.items[2] = { ...input.items[2]!, payload: {
    providerCallId: 'tool-a', toolName: 'get_asset', toolSchemaVersion: 1, arguments: { assetId: 'one' },
  } }
  input.items[3] = { ...input.items[3]!, payload: {
    content: JSON.stringify({ nodes: 1 }), status: 'completed', result: { nodes: 1 }, error: null,
  } }
  assert.ok(assembleAgentContext(input).messages.length)
  for (const [key, value] of Object.entries({ providerCallId: 'wrong', toolName: 'other_tool', toolSchemaVersion: 2 })) {
    const changed = fixture()
    changed.items[2] = { ...changed.items[2]!, payload: { [key]: value } }
    rejectsCode(() => assembleAgentContext(changed), 'AGENT_CONTEXT_CORRUPT')
    changed.items[2] = input.items[2]!
    changed.items[3] = { ...changed.items[3]!, payload: { [key]: value } }
    rejectsCode(() => assembleAgentContext(changed), 'AGENT_CONTEXT_CORRUPT')
  }
  for (const payload of [{ schemaVersion: 2 }] as JsonObject[]) {
    const changed = fixture()
    changed.items[2] = { ...changed.items[2]!, payload }
    rejectsCode(() => assembleAgentContext(changed), 'AGENT_CONTEXT_UNKNOWN')
  }
  for (const payload of [{ content: 'wrong-result' }, { status: 'failed' }] as JsonObject[]) {
    const changed = fixture()
    changed.items[3] = { ...changed.items[3]!, payload }
    rejectsCode(() => assembleAgentContext(changed), 'AGENT_CONTEXT_CORRUPT')
  }
})

test('agent context review P2: unsupported marker semantic fields and artifact references fail explicitly', () => {
  for (const index of [2, 3]) {
    const input = fixture()
    input.items[index] = { ...input.items[index]!, payload: { replacementPrompt: 'unknown semantics' } }
    rejectsCode(() => assembleAgentContext(input), 'AGENT_CONTEXT_UNKNOWN')
  }
  for (const index of [0, 3]) {
    const input = fixture()
    input.items[index] = { ...input.items[index]!, type: 'artifact_reference', payload: { artifactId: 'not-resolved' } }
    rejectsCode(() => assembleAgentContext(input), 'AGENT_CONTEXT_UNSUPPORTED')
  }
})


test('agent context integration: canonical tool rows map to versioned writer checkpoint names while markers stay canonical', async () => {
  const scope = { ownerId: '20000000-0000-4000-8000-000000000001', sessionId: '20000000-0000-4000-8000-000000000002', turnId: '20000000-0000-4000-8000-000000000003' }
  const callId = 'provider-call-1'
  const rawRound = { id: 'round-1', sessionId: scope.sessionId, turnId: scope.turnId, position: 1, status: 'completed',
    checkpoint: { text: 'checking', toolCalls: [{ id: callId, name: 'get_asset__v1', arguments: { assetId: 'a1' } }] } } as AgentContextRound
  const rawItems: AgentContextItem[] = [
    { id: 'item-1', sessionId: scope.sessionId, sequence: '1', turnId: scope.turnId, type: 'user_message', toolCallId: null, payload: { content: 'find asset' } },
    { id: 'item-2', sessionId: scope.sessionId, sequence: '2', turnId: scope.turnId, type: 'assistant_message', toolCallId: null, payload: { content: 'checking' } },
    { id: 'item-3', sessionId: scope.sessionId, sequence: '3', turnId: scope.turnId, type: 'tool_call', toolCallId: 'tool-row-1', payload: {
      providerCallId: callId, toolName: 'get_asset', toolSchemaVersion: 1, arguments: { assetId: 'a1' },
    } },
    { id: 'item-4', sessionId: scope.sessionId, sequence: '4', turnId: scope.turnId, type: 'tool_result', toolCallId: 'tool-row-1', payload: {
      content: JSON.stringify({ asset: true }), status: 'completed', result: { asset: true }, error: null,
    } },
    { id: 'item-5', sessionId: scope.sessionId, sequence: '5', turnId: scope.turnId, type: 'assistant_message', toolCallId: null, payload: { content: 'found' } },
  ]
  const rawTools = [{ id: 'tool-row-1', sessionId: scope.sessionId, turnId: scope.turnId, roundId: 'round-1', position: 0,
    providerCallId: callId, toolName: 'get_asset', toolSchemaVersion: 1, arguments: { assetId: 'a1' },
    result: { asset: true }, error: null, status: 'completed' }] as AgentContextToolCall[]
  const rawRound2: AgentContextRound = { id: 'round-2', sessionId: scope.sessionId, turnId: scope.turnId, position: 2,
    status: 'completed', checkpoint: { text: 'found', toolCalls: [] } }
  const input = fixture({ sessionId: scope.sessionId, currentTurnId: scope.turnId, items: rawItems,
    rounds: [rawRound, rawRound2], toolCalls: rawTools, turns: [{ id: scope.turnId, sessionId: scope.sessionId, status: 'completed', terminalAt: '2026-11-17T08:00:00Z' }] })
  const assembled = assembleAgentContext(input)
  assert.deepEqual(assembled.messages[1], {
    role: 'assistant', content: 'checking',
    toolCalls: [{ id: callId, name: 'get_asset__v1', arguments: { assetId: 'a1' } }],
  })
  assert.deepEqual(assembled.messages[2], { role: 'tool', toolCallId: callId, content: JSON.stringify({ asset: true }) })
})

test('agent context integration: text-only database checkpoint helper shape remains valid', () => {
  const input = fixture({
    items: [user(1, 'turn-1', 'hello'), assistant(2, 'turn-1', 'text response')],
    rounds: [round('turn-1', 1, 'text response', [])],
    toolCalls: [],
    currentTurnId: 'turn-1',
    turns: [{ id: 'turn-1', sessionId, status: 'completed', terminalAt: '2026-11-17T08:00:00Z' }],
  })
  assert.deepEqual(assembleAgentContext(input).messages, [
    { role: 'user', content: 'hello' }, { role: 'assistant', content: 'text response' },
  ])
})

function proposalFixture(options: { rawResultMissing?: boolean; internalResult?: JsonObject; internalMarker?: JsonObject } = {}): Fixture {
  const callId = 'provider-call-1'
  const internalId = 'tool-row-internal'
  const outcome: JsonObject = { mediaJobId: 'job-1' }
  const entries: AgentContextItem[] = [
    user(1, 'turn-2', 'draw an image'),
    assistant(2, 'turn-2', 'generating'),
    callMarker(3, 'turn-2', 'raw-row'),
  ]
  if (!options.rawResultMissing) entries.push(resultMarker(4, 'turn-2', 'raw-row'))
  entries.push(
    callMarker(1, 'turn-2', internalId),
    item(1, 'turn-2', 'tool_result', options.internalMarker ?? {}, internalId),
    assistant(1, 'turn-2', 'queued'),
  )
  return fixture({
    currentTurnId: 'turn-2',
    items: entries.map((entry, index) => ({ ...entry, id: `item-${index + 1}`, sequence: `${index + 1}` as AgentDecimal })),
    rounds: [
      round('turn-2', 1, 'generating', [{ id: callId, name: 'generate_image__v1', arguments: { modelId: 'm' } }]),
      round('turn-2', 2, 'queued'),
    ],
    toolCalls: [
      tool({ id: 'raw-row', turnId: 'turn-2', roundId: 'turn-2-round-1', position: 0, providerCallId: callId,
        name: 'generate_image', arguments: { modelId: 'm' }, result: outcome }),
      tool({ id: internalId, turnId: 'turn-2', roundId: 'turn-2-round-1', position: 1, providerCallId: 'agent-proposal:raw-row',
        name: 'generate_image', arguments: { canonical: true }, result: options.internalResult ?? outcome }),
    ],
    turns: [{ id: 'turn-2', sessionId, status: 'running', terminalAt: null }],
  })
}

test('agent context review F2: internal proposal rows stay out of model-visible tool calls', () => {
  const assembly = assembleAgentContext(proposalFixture())
  assert.deepEqual(assembly.messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant'])
  const assistantMessage = assembly.messages[1]!
  assert.deepEqual(assistantMessage.role === 'assistant' ? assistantMessage.toolCalls : null, [
    { id: 'provider-call-1', name: 'generate_image__v1', arguments: { modelId: 'm' } },
  ])
  const toolMessage = assembly.messages[2]!
  assert.equal(toolMessage.role === 'tool' ? toolMessage.toolCallId : '', 'provider-call-1')
  assert.equal(toolMessage.role === 'tool' ? toolMessage.content : '', JSON.stringify({ mediaJobId: 'job-1' }))
  assert.doesNotMatch(JSON.stringify(assembly.messages), /agent-proposal|tool-row-internal|canonical/)
  assert.equal(assembly.diagnostics.selectedItems, 7)
})

test('agent context review F2: an internal proposal row never satisfies a missing raw result pair', () => {
  rejectsCode(() => assembleAgentContext(proposalFixture({ rawResultMissing: true })), 'AGENT_CONTEXT_UNPAIRED')
})

test('agent context review F2: malformed internal proposal data is skipped without masking genuine corruption', () => {
  const input = proposalFixture({ internalResult: { note: '\uD800' }, internalMarker: { content: 'wrong', status: 'failed' } })
  assert.ok(assembleAgentContext(input).messages.length)
  input.items[3] = { ...input.items[3]!, payload: { result: { tampered: true } } }
  rejectsCode(() => assembleAgentContext(input), 'AGENT_CONTEXT_CORRUPT')
})

test('agent context: managed attachments are rendered as ids the model can name in edit_image', () => {
  const sourceId = '20000000-0000-4000-8000-000000000001'
  const maskId = '30000000-0000-4000-8000-000000000001'
  const sourceChecksum = 'a'.repeat(64)
  const input = fixture()
  input.items[0] = item(1, 'turn-1', 'user_message', {
    content: '把屋顶换成红色',
    attachments: [
      { kind: 'upload', id: maskId, role: 'mask', checksum: 'b'.repeat(64), width: 1200, height: 800,
        mimeType: 'image/png', preparationVersion: 1, sourceChecksum },
      { kind: 'asset', id: sourceId, role: 'reference_image', checksum: sourceChecksum, width: 1200, height: 800, mimeType: 'image/png' },
    ],
  })
  const assembly = assembleAgentContext(input)
  const first = assembly.messages[0]!
  assert.equal(first.role, 'user')
  const content = first.role === 'user' ? first.content : ''
  assert.match(content, /^把屋顶换成红色\n\n\[attached managed inputs\]/)
  assert.ok(content.includes(`- mask (image/png) uploadId=${maskId} 1200x800 sha256=bbbbbbbbbbbb prepared-for source sha256=aaaaaaaaaaaa`), content)
  assert.ok(content.includes(`- reference_image (image/png) assetId=${sourceId} 1200x800 sha256=aaaaaaaaaaaa`), content)
  assert.ok(content.includes('Use these ids as inputs[] for edit_image'), content)
})

test('agent context: an attachment payload outside the vocabulary is refused, not rendered', () => {
  const input = fixture()
  input.items[0] = item(1, 'turn-1', 'user_message', {
    content: 'go',
    attachments: [{ kind: 'upload', id: '30000000-0000-4000-8000-000000000001', role: 'reference_image',
      checksum: 'a'.repeat(64), width: 100, height: 100, mimeType: 'image/png', objectKey: 's3://leak' }],
  })
  rejectsCode(() => assembleAgentContext(input), 'AGENT_CONTEXT_UNKNOWN')

  const unboundMask = fixture()
  unboundMask.items[0] = item(1, 'turn-1', 'user_message', {
    content: 'go',
    attachments: [{ kind: 'upload', id: '30000000-0000-4000-8000-000000000001', role: 'mask',
      checksum: 'a'.repeat(64), width: 100, height: 100, mimeType: 'image/png' }],
  })
  rejectsCode(() => assembleAgentContext(unboundMask), 'AGENT_CONTEXT_UNKNOWN')
})
