import type {
  AgentDecimal,
  AgentItemType,
  AgentModelRoundStatus,
  AgentToolCallStatus,
  AgentTurnStatus,
  JsonObject,
} from '@musecanvas/contracts'
import type { LanguageModelChatContentBlock, LanguageModelChatMessage, LanguageModelChatToolCall } from '@musecanvas/providers'
import type { AgentContext, AgentContextDependencies, AgentContextPort, AgentContextRequest } from './ports'

/**
 * Agent Core context assembly.
 *
 * Persisted rows are the authority. A caller supplies the raw Item/round/tool
 * values plus explicit coverage: the assembler never assumes that a page of
 * Items is the whole session. Complete turns are selected whole; a turn is
 * rejected if its assistant calls and one result per call cannot be proven.
 */

export class AgentContextError extends Error {
  constructor(readonly code: AgentContextErrorCode) {
    super(code)
    this.name = 'AgentContextError'
  }
}

export type AgentContextErrorCode =
  | 'AGENT_CONTEXT_INVALID'
  | 'AGENT_CONTEXT_CORRUPT'
  | 'AGENT_CONTEXT_UNPAIRED'
  | 'AGENT_CONTEXT_UNKNOWN'
  | 'AGENT_CONTEXT_TRUNCATED'
  | 'AGENT_CONTEXT_TOO_LARGE'
  | 'AGENT_CONTEXT_STORE_UNAVAILABLE'
  | 'AGENT_CONTEXT_UNSUPPORTED'

/** A raw `agent_items` row projection. Payload is never returned to callers. */
export type AgentContextItem = {
  readonly id: string
  readonly sessionId: string
  readonly sequence: AgentDecimal
  readonly turnId: string
  readonly type: AgentItemType
  readonly toolCallId: string | null
  readonly payload: JsonObject
}

/** A raw `agent_model_rounds` row projection. Checkpoint text is model-visible. */
export type AgentContextRound = {
  readonly id: string
  readonly sessionId: string
  readonly turnId: string
  readonly position: number
  readonly status: AgentModelRoundStatus
  readonly checkpoint: JsonObject | null
}

/** A raw `agent_tool_calls` row projection. */
export type AgentContextToolCall = {
  readonly id: string
  readonly sessionId: string
  readonly turnId: string
  readonly roundId: string
  readonly position: number
  readonly providerCallId: string
  readonly toolName: string
  readonly toolSchemaVersion: number
  readonly arguments: JsonObject
  readonly result: JsonObject | null
  readonly error?: JsonObject | null
  readonly status: AgentToolCallStatus
}

/** Turn state read with Items in the same owner-scoped snapshot. */
export type AgentContextTurn = {
  readonly id: string
  readonly sessionId: string
  readonly status: AgentTurnStatus
  readonly terminalAt: string | null
}

/**
 * `hasNewerItems` means the supplied Item page ends before the session's latest
 * Item; `hasOlderItems` means a prefix was omitted. Either case requires a
 * complete load before assembly; the caller cannot pass a display snapshot.
 */
export type AgentContextCoverage = {
  readonly hasOlderItems: boolean
  readonly hasNewerItems: boolean
}

export type AgentContextInput = {
  /** Must match every supplied raw row; the loader must authorize this Session's owner. */
  readonly sessionId: string
  readonly currentTurnId: string
  readonly items: readonly AgentContextItem[]
  readonly rounds: readonly AgentContextRound[]
  readonly toolCalls: readonly AgentContextToolCall[]
  readonly turns: readonly AgentContextTurn[]
  readonly coverage: AgentContextCoverage
  readonly maxBytes?: number
  readonly maxTurns?: number
}

export type AgentContextDiagnostics = {
  readonly selectedTurns: number
  readonly omittedTurns: number
  readonly selectedItems: number
  readonly omittedItems: number
  readonly bytes: number
  readonly truncatedByTurns: boolean
  readonly truncatedByBytes: boolean
  readonly droppedLeadingPartialTurn: boolean
  readonly sourceWindowTruncated: boolean
}

export type AgentContextAssembly = {
  readonly messages: LanguageModelChatMessage[]
  readonly diagnostics: AgentContextDiagnostics
}

type ValidItem = {
  item: AgentContextItem
  sequence: bigint
  payload: JsonObject
}

type TurnGroup = {
  turnId: string
  items: ValidItem[]
}

const itemTypes: readonly AgentItemType[] = [
  'user_message', 'assistant_message', 'tool_call', 'tool_result', 'approval', 'artifact_reference', 'system_event',
]
const roundStatuses: readonly AgentModelRoundStatus[] = ['recorded', 'running', 'completed', 'failed', 'superseded']
const toolStatuses: readonly AgentToolCallStatus[] = [
  'recorded', 'validating', 'waiting_approval', 'executing', 'waiting_external', 'completed', 'failed', 'cancelled', 'skipped',
]
const terminalToolStatuses: readonly AgentToolCallStatus[] = ['completed', 'failed', 'cancelled', 'skipped']
const ignoreItemTypes: readonly AgentItemType[] = ['approval', 'system_event']
const turnStatuses: readonly AgentTurnStatus[] = ['queued', 'running', 'waiting_tools', 'waiting_approval', 'completed', 'failed', 'cancelled']
const maxSequence = 9223372036854775807n
const maxSourceItems = 10_000
const maxSourceRounds = 20_000
const maxSourceTools = 20_000
const defaultMaxBytes = 100_000
const defaultMaxTurns = 8
const providerToolPattern = /^[A-Za-z0-9_-]{1,200}$/
const canonicalToolPattern = /^[a-z][a-z0-9_]{0,39}$/
const providerCallPattern = /^[A-Za-z0-9_-]{1,200}$/
/**
 * Canonical media proposals are materialized internal rows, not calls the model
 * emitted. Their provider ids carry this prefix and never reach the wire.
 */
export const AGENT_PROPOSAL_TOOL_CALL_PREFIX = 'agent-proposal:'
const surrogatePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(code: AgentContextErrorCode): never {
  throw new AgentContextError(code)
}

function text(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.includes('\0') || surrogatePattern.test(value)) fail('AGENT_CONTEXT_INVALID')
  if (Buffer.byteLength(value, 'utf8') > maxBytes) fail('AGENT_CONTEXT_TOO_LARGE')
  return value
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 200 || value.includes('\0')
    || surrogatePattern.test(value)) fail('AGENT_CONTEXT_INVALID')
  return value
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('AGENT_CONTEXT_INVALID')
  return value as Record<string, unknown>
}

function safeJson(value: unknown, depth = 0, state = { nodes: 0, bytes: 0 }): void {
  state.nodes++
  if (state.nodes > 100_000 || depth > 100) fail('AGENT_CONTEXT_TOO_LARGE')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    if (value.includes('\0') || surrogatePattern.test(value)) fail('AGENT_CONTEXT_INVALID')
    state.bytes += Buffer.byteLength(value, 'utf8')
    if (state.bytes > 1_000_000) fail('AGENT_CONTEXT_TOO_LARGE')
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('AGENT_CONTEXT_INVALID')
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) safeJson(entry, depth + 1, state)
    return
  }
  const record = object(value)
  for (const [key, entry] of Object.entries(record)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('AGENT_CONTEXT_INVALID')
    state.bytes += Buffer.byteLength(key, 'utf8')
    if (state.bytes > 1_000_000) fail('AGENT_CONTEXT_TOO_LARGE')
    safeJson(entry, depth + 1, state)
  }
}

function jsonObject(value: unknown): JsonObject {
  const record = object(value)
  safeJson(record)
  return record as JsonObject
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) fail('AGENT_CONTEXT_INVALID')
  const parsed = BigInt(value)
  if (parsed < 1n || parsed > maxSequence) fail('AGENT_CONTEXT_INVALID')
  return parsed
}

function source<T>(value: readonly T[] | undefined, maximum: number): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) fail('AGENT_CONTEXT_TOO_LARGE')
  return value
}

function contentBytes(content: unknown, maxBytes: number): string {
  if (typeof content !== 'string') fail('AGENT_CONTEXT_INVALID')
  return text(content, maxBytes)
}

function checkpointObject(round: AgentContextRound): JsonObject {
  if (!round.checkpoint) fail('AGENT_CONTEXT_CORRUPT')
  return jsonObject(round.checkpoint)
}

function checkpointCalls(checkpoint: JsonObject): LanguageModelChatToolCall[] {
  if (!Array.isArray(checkpoint.toolCalls)) fail('AGENT_CONTEXT_CORRUPT')
  const calls: LanguageModelChatToolCall[] = []
  const ids = new Set<string>()
  for (const raw of checkpoint.toolCalls) {
    const call = object(raw)
    const id = identifier(call.id)
    const name = identifier(call.name)
    if (!providerCallPattern.test(id) || !providerToolPattern.test(name) || ids.has(id)) fail('AGENT_CONTEXT_CORRUPT')
    ids.add(id)
    calls.push({ id, name, arguments: jsonObject(call.arguments) })
  }
  return calls
}

function visibleBlocks(checkpoint: JsonObject, content: string, calls: LanguageModelChatToolCall[]): LanguageModelChatContentBlock[] | undefined {
  if (checkpoint.contentBlocks === undefined) return undefined
  if (!Array.isArray(checkpoint.contentBlocks)) fail('AGENT_CONTEXT_CORRUPT')
  const blocks: LanguageModelChatContentBlock[] = []
  const blockCalls: LanguageModelChatToolCall[] = []
  let textContent = ''
  for (const raw of checkpoint.contentBlocks) {
    const block = object(raw)
    if (block.type === 'text' && typeof block.text === 'string') {
      textContent += block.text
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_call') {
      const call = checkpointCalls({ toolCalls: [block.toolCall as JsonObject] })[0]!
      blockCalls.push(call)
      blocks.push({ type: 'tool_call', toolCall: call })
    } else fail('AGENT_CONTEXT_UNKNOWN')
  }
  if (textContent !== content || canonicalJson(blockCalls) !== canonicalJson(calls)) fail('AGENT_CONTEXT_CORRUPT')
  return blocks
}

function validItem(raw: AgentContextItem): ValidItem {
  if (!raw || typeof raw !== 'object') fail('AGENT_CONTEXT_INVALID')
  identifier(raw.id)
  identifier(raw.sessionId)
  identifier(raw.turnId)
  if (!itemTypes.includes(raw.type)) fail('AGENT_CONTEXT_UNKNOWN')
  if (raw.type === 'artifact_reference') fail('AGENT_CONTEXT_UNSUPPORTED')
  if (raw.toolCallId !== null && typeof raw.toolCallId !== 'string') fail('AGENT_CONTEXT_INVALID')
  if (raw.toolCallId) identifier(raw.toolCallId)
  return { item: raw, sequence: decimal(raw.sequence), payload: jsonObject(raw.payload) }
}

function validRound(raw: AgentContextRound): { round: AgentContextRound; position: number; checkpoint: JsonObject | null } {
  if (!raw || typeof raw !== 'object') fail('AGENT_CONTEXT_INVALID')
  identifier(raw.id)
  identifier(raw.turnId)
  if (!Number.isSafeInteger(raw.position) || raw.position < 1) fail('AGENT_CONTEXT_CORRUPT')
  if (!roundStatuses.includes(raw.status)) fail('AGENT_CONTEXT_UNKNOWN')
  const checkpoint = raw.checkpoint === null ? null : jsonObject(raw.checkpoint)
  if (raw.status === 'completed' && checkpoint === null) fail('AGENT_CONTEXT_CORRUPT')
  return { round: raw, position: raw.position, checkpoint }
}

function validTool(raw: AgentContextToolCall): AgentContextToolCall {
  if (!raw || typeof raw !== 'object') fail('AGENT_CONTEXT_INVALID')
  identifier(raw.id)
  identifier(raw.turnId)
  identifier(raw.roundId)
  if (!Number.isSafeInteger(raw.position) || raw.position < 0) fail('AGENT_CONTEXT_CORRUPT')
  if (typeof raw.providerCallId !== 'string' || !providerCallPattern.test(raw.providerCallId)) fail('AGENT_CONTEXT_CORRUPT')
  if (typeof raw.toolName !== 'string' || !providerToolPattern.test(raw.toolName)) fail('AGENT_CONTEXT_CORRUPT')
  if (!Number.isSafeInteger(raw.toolSchemaVersion) || raw.toolSchemaVersion < 1) fail('AGENT_CONTEXT_CORRUPT')
  if (!toolStatuses.includes(raw.status)) fail('AGENT_CONTEXT_UNKNOWN')
  jsonObject(raw.arguments)
  if (raw.result !== null) jsonObject(raw.result)
  if (raw.error !== undefined && raw.error !== null) jsonObject(raw.error)
  return raw
}

function wireToolName(tool: AgentContextToolCall): string {
  if (!canonicalToolPattern.test(tool.toolName) || tool.toolName.includes('__v')
    || !Number.isSafeInteger(tool.toolSchemaVersion) || tool.toolSchemaVersion < 1 || tool.toolSchemaVersion > 999_999) {
    fail('AGENT_CONTEXT_CORRUPT')
  }
  return `${tool.toolName}__v${tool.toolSchemaVersion}`
}

function validateMarker(payload: JsonObject, type: 'tool_call' | 'tool_result', tool: AgentContextToolCall): void {
  const identities: Record<string, string | number> = { providerCallId: tool.providerCallId, toolName: tool.toolName,
    toolSchemaVersion: tool.toolSchemaVersion }
  const fields = type === 'tool_call' ? ['arguments'] : ['content', 'status', 'result', 'error']
  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(identities, key) && !fields.includes(key)) fail('AGENT_CONTEXT_UNKNOWN')
    if (Object.hasOwn(identities, key) && payload[key] !== identities[key]) fail('AGENT_CONTEXT_CORRUPT')
  }
  if (payload.arguments !== undefined && canonicalJson(payload.arguments) !== canonicalJson(tool.arguments)) fail('AGENT_CONTEXT_CORRUPT')
  if (payload.result !== undefined && canonicalJson(payload.result) !== canonicalJson(tool.result)) fail('AGENT_CONTEXT_CORRUPT')
  if (payload.error !== undefined && canonicalJson(payload.error) !== canonicalJson(tool.error ?? null)) fail('AGENT_CONTEXT_CORRUPT')
  if (payload.status !== undefined && payload.status !== tool.status) fail('AGENT_CONTEXT_CORRUPT')
  if (payload.content !== undefined && payload.content !== JSON.stringify(tool.result ?? tool.error)) fail('AGENT_CONTEXT_CORRUPT')
}

function validTurn(raw: AgentContextTurn, sessionId: string): AgentContextTurn {
  if (!raw || typeof raw !== 'object' || raw.sessionId !== sessionId) fail('AGENT_CONTEXT_INVALID')
  identifier(raw.id)
  if (!turnStatuses.includes(raw.status)) fail('AGENT_CONTEXT_UNKNOWN')
  const terminal = ['completed', 'failed', 'cancelled'].includes(raw.status)
  if (terminal ? typeof raw.terminalAt !== 'string' || !Number.isFinite(Date.parse(raw.terminalAt)) : raw.terminalAt !== null) {
    fail('AGENT_CONTEXT_CORRUPT')
  }
  return raw
}

function groupByTurn(items: ValidItem[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const turnId = item.item.turnId
    if (!groups.length || groups.at(-1)!.turnId !== turnId) {
      if (seen.has(turnId)) fail('AGENT_CONTEXT_CORRUPT')
      seen.add(turnId)
      groups.push({ turnId, items: [item] })
    } else {
      groups.at(-1)!.items.push(item)
    }
  }
  return groups
}

function buildTurn(
  group: TurnGroup,
  rounds: readonly AgentContextRound[],
  tools: readonly AgentContextToolCall[],
  maxBytes: number,
  seenCallIds: Set<string>,
): { messages: LanguageModelChatMessage[]; itemCount: number } {
  const turnRounds = rounds.filter(round => round.turnId === group.turnId).sort((a, b) => a.position - b.position)
  const turnTools = tools.filter(tool => tool.turnId === group.turnId)
  // Internal proposal rows are implementation detail. Neither the row nor its
  // markers may occupy a pairing slot or add to the checkpoint call count.
  const internalTools = new Set(turnTools
    .filter(tool => typeof tool.providerCallId === 'string' && tool.providerCallId.startsWith(AGENT_PROPOSAL_TOOL_CALL_PREFIX))
    .map(tool => tool.id))
  const assistants = group.items.filter(item => item.item.type === 'assistant_message')
  if (assistants.length !== turnRounds.length) fail('AGENT_CONTEXT_CORRUPT')
  for (const [index, round] of turnRounds.entries()) {
    const parsed = validRound(round)
    if (parsed.position !== index + 1 || round.status !== 'completed') fail('AGENT_CONTEXT_CORRUPT')
  }

  const toolsByRound = new Map<string, AgentContextToolCall[]>()
  for (const raw of turnTools) {
    if (internalTools.has(raw.id)) continue
    const tool = validTool(raw)
    if (!turnRounds.some(round => round.id === tool.roundId)) fail('AGENT_CONTEXT_CORRUPT')
    const entries = toolsByRound.get(tool.roundId) ?? []
    entries.push(tool)
    toolsByRound.set(tool.roundId, entries)
  }

  const messages: LanguageModelChatMessage[] = []
  let assistantIndex = 0
  for (let index = 0; index < group.items.length; index++) {
    const entry = group.items[index]!
    if (entry.item.type === 'user_message') {
      const content = contentBytes(entry.payload.content, 32_000)
      if (!content.trim()) fail('AGENT_CONTEXT_CORRUPT')
      messages.push({ role: 'user', content })
      continue
    }
    if (entry.item.type === 'tool_call' || entry.item.type === 'tool_result') {
      if (entry.item.toolCallId && internalTools.has(entry.item.toolCallId)) continue
      // Tool markers are consumed only inside their assistant round. Reaching
      // this branch means the marker is outside any paired call/result block.
      fail('AGENT_CONTEXT_UNPAIRED')
    }
    if (entry.item.type !== 'assistant_message') {
      if (!ignoreItemTypes.includes(entry.item.type)) fail('AGENT_CONTEXT_UNKNOWN')
      continue
    }

    const round = turnRounds[assistantIndex++]!
    const checkpoint = checkpointObject(round)
    const roundText = contentBytes(checkpoint.text, 32_000)
    if (contentBytes(entry.payload.content, 32_000) !== roundText) fail('AGENT_CONTEXT_CORRUPT')
    const roundTools = (toolsByRound.get(round.id) ?? []).slice().sort((a, b) => a.position - b.position)
    for (const [position, tool] of roundTools.entries()) {
      if (tool.position !== position) fail('AGENT_CONTEXT_CORRUPT')
      if (seenCallIds.has(tool.providerCallId)) fail('AGENT_CONTEXT_CORRUPT')
      seenCallIds.add(tool.providerCallId)
    }
    const recordedCalls = checkpointCalls(checkpoint)
    if (recordedCalls) {
      if (recordedCalls.length !== roundTools.length) fail('AGENT_CONTEXT_CORRUPT')
      for (const [position, call] of recordedCalls.entries()) {
        const tool = roundTools[position]!
        if (call.id !== tool.providerCallId || call.name !== wireToolName(tool)
          || canonicalJson(call.arguments) !== canonicalJson(tool.arguments)) fail('AGENT_CONTEXT_CORRUPT')
      }
    }
    if (!roundText.trim() && roundTools.length === 0) fail('AGENT_CONTEXT_CORRUPT')

    let boundary = index + 1
    while (boundary < group.items.length) {
      const type = group.items[boundary]!.item.type
      if (type === 'user_message' || type === 'assistant_message') break
      boundary++
    }
    const callMarkers = new Map<string, number>()
    const resultMarkers = new Map<string, number>()
    for (let markerIndex = index + 1; markerIndex < boundary; markerIndex++) {
      const marker = group.items[markerIndex]!.item
      if (marker.type !== 'tool_call' && marker.type !== 'tool_result') continue
      const toolCallId = marker.toolCallId
      if (!toolCallId) fail('AGENT_CONTEXT_UNPAIRED')
      if (internalTools.has(toolCallId)) continue
      const tool = roundTools.find(candidate => candidate.id === toolCallId)
      if (!tool) fail('AGENT_CONTEXT_UNPAIRED')
      const target = marker.type === 'tool_call' ? callMarkers : resultMarkers
      if (marker.type === 'tool_result' && callMarkers.get(toolCallId) !== 1) fail('AGENT_CONTEXT_UNPAIRED')
      validateMarker(group.items[markerIndex]!.payload, marker.type, tool)
      target.set(toolCallId, (target.get(toolCallId) ?? 0) + 1)
    }

    const calls: LanguageModelChatToolCall[] = []
    const results: LanguageModelChatMessage[] = []
    for (const tool of roundTools) {
      if (!terminalToolStatuses.includes(tool.status)) fail('AGENT_CONTEXT_UNPAIRED')
      if (tool.status === 'completed' && tool.result === null) fail('AGENT_CONTEXT_UNPAIRED')
      if (tool.status !== 'completed' && tool.result === null && !tool.error) fail('AGENT_CONTEXT_UNPAIRED')
      if (callMarkers.get(tool.id) !== 1 || resultMarkers.get(tool.id) !== 1) fail('AGENT_CONTEXT_UNPAIRED')
      calls.push({ id: tool.providerCallId, name: wireToolName(tool), arguments: tool.arguments })
      const serialized = JSON.stringify(tool.result ?? tool.error)
      if (Buffer.byteLength(serialized, 'utf8') > maxBytes) fail('AGENT_CONTEXT_TOO_LARGE')
      results.push({
        role: 'tool',
        toolCallId: tool.providerCallId,
        content: serialized,
        ...(tool.status === 'completed' ? {} : { isError: true }),
      })
    }
    const contentBlocks = visibleBlocks(checkpoint, roundText, calls)
    messages.push({ role: 'assistant', content: roundText, ...(calls.length ? { toolCalls: calls } : {}),
      ...(contentBlocks ? { contentBlocks } : {}) })
    messages.push(...results)
    index = boundary - 1
  }
  if (assistantIndex !== turnRounds.length) fail('AGENT_CONTEXT_CORRUPT')
  return { messages, itemCount: group.items.length }
}

function bytes(messages: readonly LanguageModelChatMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8')
}

export function assembleAgentContext(input: AgentContextInput): AgentContextAssembly {
  if (!input || typeof input !== 'object') fail('AGENT_CONTEXT_INVALID')
  const currentTurnId = identifier(input.currentTurnId)
  const sessionId = identifier(input.sessionId)
  if (!input.coverage || typeof input.coverage !== 'object'
    || typeof input.coverage.hasOlderItems !== 'boolean' || typeof input.coverage.hasNewerItems !== 'boolean') {
    fail('AGENT_CONTEXT_INVALID')
  }
  if (input.coverage.hasNewerItems || input.coverage.hasOlderItems) fail('AGENT_CONTEXT_TRUNCATED')
  const maxBytes = input.maxBytes ?? defaultMaxBytes
  const maxTurns = input.maxTurns ?? defaultMaxTurns
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000
    || !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) fail('AGENT_CONTEXT_INVALID')

  const items = source(input.items, maxSourceItems)
    .map(validItem)
    .sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0)
  for (const item of items) if (item.item.sessionId !== sessionId) fail('AGENT_CONTEXT_INVALID')
  if (items.length && items[0]!.sequence !== 1n) fail('AGENT_CONTEXT_TRUNCATED')
  for (let index = 1; index < items.length; index++) {
    if (items[index - 1]!.sequence === items[index]!.sequence) fail('AGENT_CONTEXT_CORRUPT')
    if (items[index - 1]!.sequence + 1n !== items[index]!.sequence) fail('AGENT_CONTEXT_TRUNCATED')
  }
  if (!items.length) fail('AGENT_CONTEXT_INVALID')
  const groups = groupByTurn(items)
  for (const group of groups) {
    if (group.items[0]!.item.type !== 'user_message') fail('AGENT_CONTEXT_CORRUPT')
  }
  if (groups.at(-1)!.turnId !== currentTurnId) fail('AGENT_CONTEXT_INVALID')

  const selectedTurnIds = new Set(groups.map(group => group.turnId))
  const turns = new Map<string, AgentContextTurn>()
  for (const raw of source(input.turns, maxSourceItems)) {
    const turn = validTurn(raw, sessionId)
    if (turns.has(turn.id)) fail('AGENT_CONTEXT_CORRUPT')
    turns.set(turn.id, turn)
  }
  for (const group of groups) if (!turns.has(group.turnId)) fail('AGENT_CONTEXT_CORRUPT')
  const rounds = source(input.rounds, maxSourceRounds).filter(round => {
    if (!round || typeof round !== 'object') fail('AGENT_CONTEXT_INVALID')
    identifier(round.turnId)
    if (round.sessionId !== sessionId) fail('AGENT_CONTEXT_INVALID')
    if (selectedTurnIds.has(round.turnId)) return true
    return fail('AGENT_CONTEXT_UNKNOWN')
  })
  const tools = source(input.toolCalls, maxSourceTools).filter(tool => {
    if (!tool || typeof tool !== 'object') fail('AGENT_CONTEXT_INVALID')
    identifier(tool.turnId)
    if (tool.sessionId !== sessionId) fail('AGENT_CONTEXT_INVALID')
    if (selectedTurnIds.has(tool.turnId)) return true
    return fail('AGENT_CONTEXT_UNKNOWN')
  })

  for (const rows of [items.map(entry => entry.item), rounds, tools]) {
    const ids = new Set<string>()
    for (const row of rows) {
      if (ids.has(row.id)) fail('AGENT_CONTEXT_CORRUPT')
      ids.add(row.id)
    }
  }
  const seenCallIds = new Set<string>()
  const built = groups.map(group => {
    const builtTurn = buildTurn(group, rounds, tools, maxBytes, seenCallIds)
    if (group.turnId !== currentTurnId) {
      const last = builtTurn.messages.at(-1)
      const status = turns.get(group.turnId)!.status
      if (status !== 'cancelled' && status !== 'failed'
        && (status !== 'completed' || last?.role !== 'assistant' || last.toolCalls?.length)) fail('AGENT_CONTEXT_UNPAIRED')
    }
    return { group, ...builtTurn }
  })
  const totalTurns = built.length
  let selected = built.slice(-maxTurns)
  const truncatedByTurns = selected.length < totalTurns
  let selectedBytes = bytes(selected.flatMap(turn => turn.messages))
  let truncatedByBytes = false
  while (selectedBytes > maxBytes && selected.length > 1) {
    selected = selected.slice(1)
    truncatedByBytes = true
    selectedBytes = bytes(selected.flatMap(turn => turn.messages))
  }
  if (selectedBytes > maxBytes) fail('AGENT_CONTEXT_TOO_LARGE')
  if (!selected.length) fail('AGENT_CONTEXT_CORRUPT')
  const selectedItems = selected.reduce((total, turn) => total + turn.itemCount, 0)
  const totalItems = built.reduce((total, turn) => total + turn.itemCount, 0)
  return {
    messages: selected.flatMap(turn => turn.messages),
    diagnostics: {
      selectedTurns: selected.length,
      omittedTurns: totalTurns - selected.length,
      selectedItems,
      omittedItems: totalItems - selectedItems,
      bytes: selectedBytes,
      truncatedByTurns,
      truncatedByBytes,
      droppedLeadingPartialTurn: false,
      sourceWindowTruncated: false,
    },
  }
}

function scopedId(value: string): string {
  if (!uuidPattern.test(value)) fail('AGENT_CONTEXT_INVALID')
  return value.toLowerCase()
}

function rowObject(value: unknown): Record<string, unknown> {
  return object(value)
}

/**
 * Frozen `AgentContextPort` adapter. It loads the raw owner-scoped session rows
 * inside the caller's read-only transaction and passes them to the same strict
 * assembler used by tests. Both coverage flags are false only because every
 * session Item is read; Item sequence continuity is still verified.
 */
export interface AgentContextFactoryPort extends AgentContextPort {
  build(input: AgentContextRequest): Promise<AgentContext & { diagnostics: AgentContextDiagnostics }>
}

export function createAgentContext(dependencies: AgentContextDependencies): AgentContextFactoryPort {
  return {
    async build(request: AgentContextRequest) {
      const ownerId = scopedId(request.ownerId)
      const sessionId = scopedId(request.sessionId)
      const turnId = scopedId(request.turnId)
      if (typeof request.instructions !== 'string' || !request.instructions.trim()
        || Buffer.byteLength(request.instructions, 'utf8') > 100_000) fail('AGENT_CONTEXT_INVALID')
      try {
        return await dependencies.transaction(async client => {
        const turn = (await client.query(`SELECT t.config_snapshot,s.next_item_sequence::text AS next_item_sequence FROM agent_turns t
          JOIN agent_sessions s ON s.id=t.session_id JOIN users u ON u.id=s.owner_id
          WHERE s.owner_id=$1 AND s.id=$2 AND t.id=$3 AND t.engine_version='agent-core-v1'
            AND s.active_turn_id=t.id AND s.archived_at IS NULL AND u.status='active' AND u.deleted_at IS NULL
            AND t.status='running' AND t.cancel_requested_at IS NULL AND clock_timestamp()<t.deadline_at`,
          [ownerId, sessionId, turnId])).rows[0]
        if (!turn) fail('AGENT_CONTEXT_INVALID')
        const config = rowObject(turn.config_snapshot)
        if (typeof config.instructions !== 'string' || config.instructions !== request.instructions) fail('AGENT_CONTEXT_CORRUPT')

        const turns = (await client.query(`SELECT t.id,t.session_id,t.status,t.terminal_at FROM agent_turns t
          JOIN agent_sessions s ON s.id=t.session_id WHERE s.owner_id=$1 AND s.id=$2 LIMIT 10001`, [ownerId, sessionId])).rows
          .map(row => ({ id: row.id as string, sessionId: row.session_id as string, status: row.status as AgentTurnStatus,
            terminalAt: row.terminal_at instanceof Date ? row.terminal_at.toISOString() : row.terminal_at as string | null }))
        const items = (await client.query(`SELECT id,session_id,sequence::text AS sequence,turn_id,item_type,tool_call_id,payload
          FROM agent_items WHERE session_id=$1 ORDER BY sequence LIMIT 10001`, [sessionId])).rows
          .map(row => ({
            id: row.id as string, sessionId: row.session_id as string, sequence: row.sequence as AgentDecimal,
            turnId: row.turn_id as string, type: row.item_type as AgentItemType, toolCallId: row.tool_call_id as string | null,
            payload: rowObject(row.payload) as JsonObject,
          }))
        const rounds = (await client.query(`SELECT id,session_id,turn_id,position,status,checkpoint
          FROM agent_model_rounds WHERE session_id=$1 AND status='completed' ORDER BY turn_id,position LIMIT 20001`, [sessionId])).rows
          .map(row => ({
            id: row.id as string, sessionId: row.session_id as string, turnId: row.turn_id as string,
            position: Number(row.position), status: row.status as AgentContextRound['status'],
            checkpoint: row.checkpoint === null ? null : rowObject(row.checkpoint) as JsonObject,
          }))
        const tools = (await client.query(`SELECT x.id,x.session_id,x.turn_id,x.round_id,x.position,x.provider_call_id,
            x.tool_name,x.tool_schema_version,x.arguments,x.result,x.error,x.status
          FROM agent_tool_calls x JOIN agent_model_rounds r ON r.id=x.round_id
          WHERE x.session_id=$1 AND r.session_id=$1 AND r.status='completed' ORDER BY x.round_id,x.position LIMIT 20001`, [sessionId])).rows
          .map(row => ({
            id: row.id as string, sessionId: row.session_id as string, turnId: row.turn_id as string,
            roundId: row.round_id as string, position: Number(row.position), providerCallId: row.provider_call_id as string,
            toolName: row.tool_name as string, toolSchemaVersion: Number(row.tool_schema_version),
            arguments: rowObject(row.arguments) as JsonObject, result: row.result === null ? null : rowObject(row.result) as JsonObject,
            error: row.error === null || row.error === undefined ? null : rowObject(row.error) as JsonObject,
            status: row.status as AgentContextToolCall['status'],
          }))
        if (typeof turn.next_item_sequence !== 'string' || !/^[1-9][0-9]{0,18}$/.test(turn.next_item_sequence)
          || BigInt(turn.next_item_sequence) - 1n !== BigInt(items.at(-1)?.sequence ?? '0')) fail('AGENT_CONTEXT_TRUNCATED')
        const assembly = assembleAgentContext({
          sessionId,
          currentTurnId: turnId,
          items,
          rounds,
          toolCalls: tools,
          turns,
          coverage: { hasOlderItems: false, hasNewerItems: false },
          ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
          ...(request.maxTurns === undefined ? {} : { maxTurns: request.maxTurns }),
        })
        return { system: config.instructions, messages: assembly.messages, diagnostics: assembly.diagnostics }
        })
      } catch (error) {
        if (error instanceof AgentContextError) throw error
        fail('AGENT_CONTEXT_STORE_UNAVAILABLE')
      }
    },
  }
}
