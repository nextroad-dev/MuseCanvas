// Pure reducer for the Canvas Agent conversation timeline.
//
// The live POST-SSE stream and the persisted history endpoint describe the same
// turn from two angles, so the timeline has to reconcile them without duplicating
// anything on reload. Three identity rules make that possible:
//
// 1. Persisted messages are keyed by their server `message.id` (`msg:<id>`), and
//    ordered by their monotonic `seq`. History pages therefore merge in place.
// 2. Live `text_delta` segments are *provisional* (`p:<turnId>:<n>`): the server
//    sends a complete model text segment, not token deltas. When the terminal
//    `done` frame (or a replayed history page) supplies the persisted message with
//    the same text, the provisional copy is dropped.
// 3. Tool calls/results are grouped by `toolCallId`, pending proposals by their
//    pending id — both stable across reconnects and replays.
//
// SSE `eventId` is deliberately never used for identity: the server regenerates it
// on replay, so keying on it would duplicate a recovered turn. Nothing here imports
// React; the hook owns effects and the confirmation cards own presentation.

import type {
  AgentMessageDto,
  AgentStreamEvent,
  CanvasAgentApplyResultDto,
  CanvasAgentPendingJobDto,
  CanvasAgentStatusDto,
  CanvasAgentStructuredContext,
  CanvasAgentUsageDto,
  CanvasOp,
  JsonObject,
  JsonValue,
} from '@musecanvas/contracts'

export interface UserTimelineItem {
  kind: 'user'
  id: string
  text: string
  turnId: string | null
  seq: number | null
  contextSummary?: CanvasAgentStructuredContext
  createdAt: string | null
}

export interface AssistantTimelineItem {
  kind: 'assistant'
  id: string
  text: string
  turnId: string | null
  seq: number | null
  /** `true` for live `text_delta` segments not yet reconciled with a persisted message. */
  provisional: boolean
  usage?: CanvasAgentUsageDto
  /** Persisted canvas proposal carried by a `done`/history assistant message. */
  ops?: CanvasOp[]
  createdAt: string | null
}

export interface ToolTimelineItem {
  kind: 'tool'
  id: string
  toolCallId: string
  turnId: string
  name: string | null
  arguments: JsonObject | null
  result: JsonValue | null
  success: boolean | null
  seq: number | null
}

/** A proposal from the Agent: never presented as an applied scene. */
export interface CanvasOpsTimelineItem {
  kind: 'canvas_ops'
  id: string
  turnId: string
  ops: CanvasOp[]
  baseRevision: number
}

export interface PendingTimelineItem {
  kind: 'pending'
  id: string
  pending: CanvasAgentPendingJobDto
}

export interface ErrorTimelineItem {
  kind: 'error'
  id: string
  turnId: string
  code: string
  message: string
  retryable: boolean
}

export type TimelineItem =
  | UserTimelineItem
  | AssistantTimelineItem
  | ToolTimelineItem
  | CanvasOpsTimelineItem
  | PendingTimelineItem
  | ErrorTimelineItem

export interface AgentTimelineState {
  items: TimelineItem[]
  byId: Map<string, number>
  toolByCallId: Map<string, number>
  pendingById: Map<string, number>
  /** Per-turn counter for provisional segment / ops / error keys. */
  counters: Map<string, number>
}

export function createAgentTimeline(): AgentTimelineState {
  return { items: [], byId: new Map(), toolByCallId: new Map(), pendingById: new Map(), counters: new Map() }
}

/** True when the signed-in actor changed: the hook uses this to abort the stream
 *  and drop the previous actor's timeline/cache instead of leaking it across. */
export function agentScopeChanged(previousActorId: string | null | undefined, nextActorId: string | null | undefined): boolean {
  // `''` (anonymous/no user) and `null`/`undefined` all mean "no actor".
  return (previousActorId || null) !== (nextActorId || null)
}

function clone(state: AgentTimelineState): AgentTimelineState {
  return {
    items: state.items.slice(),
    byId: new Map(state.byId),
    toolByCallId: new Map(state.toolByCallId),
    pendingById: new Map(state.pendingById),
    counters: new Map(state.counters),
  }
}

function nextCounter(state: AgentTimelineState, turnId: string): number {
  const value = (state.counters.get(turnId) ?? 0) + 1
  state.counters.set(turnId, value)
  return value
}

function replaceAt(state: AgentTimelineState, item: TimelineItem, index: number): void {
  state.items[index] = item
}

/** Insert an item. Live items (`seq === null`, e.g. the optimistic user message or
 *  an in-flight tool frame) have no server order, so they are appended and a later
 *  persisted message with a large seq still lands at the end. Among persisted
 *  messages the array stays ascending by seq, which is what makes loading an
 *  older history page prepend instead of reorder. */
function itemSeq(item: TimelineItem): number | null {
  return 'seq' in item ? item.seq : null
}

function insertOrdered(state: AgentTimelineState, item: TimelineItem): void {
  const seq = itemSeq(item)
  let at = state.items.length
  if (seq !== null) {
    for (let i = 0; i < state.items.length; i++) {
      const existingSeq = itemSeq(state.items[i]!)
      if (existingSeq !== null && existingSeq > seq) {
        at = i
        break
      }
    }
  }
  state.items.splice(at, 0, item)
  state.byId.set(item.id, at)
  // Insertion shifts every later item, so all three lookup maps must be re-derived
  // from the splice point; leaving toolByCallId/pendingById stale makes a later
  // upsert replace the wrong item after "load more history".
  for (let i = at + 1; i < state.items.length; i++) {
    const shifted = state.items[i]!
    state.byId.set(shifted.id, i)
    if (shifted.kind === 'tool') state.toolByCallId.set(shifted.toolCallId, i)
    if (shifted.kind === 'pending') state.pendingById.set(shifted.pending.id, i)
  }
}

/** Resolve a tool index defensively: if a stale map points at the wrong item,
 *  fall back to a scan and repair the map instead of corrupting another entry. */
function toolIndexOf(state: AgentTimelineState, toolCallId: string): number | undefined {
  const index = state.toolByCallId.get(toolCallId)
  const current = index === undefined ? undefined : state.items[index]
  if (current && current.kind === 'tool' && current.toolCallId === toolCallId) return index
  const found = state.items.findIndex((item) => item.kind === 'tool' && item.toolCallId === toolCallId)
  if (found < 0) return undefined
  state.toolByCallId.set(toolCallId, found)
  return found
}

function pendingIndexOf(state: AgentTimelineState, pendingId: string): number | undefined {
  const index = state.pendingById.get(pendingId)
  const current = index === undefined ? undefined : state.items[index]
  if (current && current.kind === 'pending' && current.pending.id === pendingId) return index
  const found = state.items.findIndex((item) => item.kind === 'pending' && item.pending.id === pendingId)
  if (found < 0) return undefined
  state.pendingById.set(pendingId, found)
  return found
}

function upsertMessage(state: AgentTimelineState, item: UserTimelineItem | AssistantTimelineItem): void {
  const index = state.byId.get(item.id)
  if (index !== undefined) {
    replaceAt(state, item, index)
    return
  }
  insertOrdered(state, item)
}

function upsertToolCall(state: AgentTimelineState, input: {
  toolCallId: string
  turnId: string
  seq: number | null
  name?: string
  args?: JsonObject
}): void {
  const id = `tool:${input.toolCallId}`
  const index = toolIndexOf(state, input.toolCallId)
  if (index !== undefined) {
    const current = state.items[index] as ToolTimelineItem
    replaceAt(state, {
      ...current,
      name: input.name ?? current.name,
      arguments: input.args ?? current.arguments,
      seq: current.seq ?? input.seq,
    }, index)
    return
  }
  const item: ToolTimelineItem = {
    kind: 'tool',
    id,
    toolCallId: input.toolCallId,
    turnId: input.turnId,
    name: input.name ?? null,
    arguments: input.args ?? null,
    result: null,
    success: null,
    seq: input.seq,
  }
  state.items.push(item)
  state.toolByCallId.set(input.toolCallId, state.items.length - 1)
  state.byId.set(id, state.items.length - 1)
}

function upsertToolResult(state: AgentTimelineState, input: {
  toolCallId: string
  turnId: string
  result: JsonValue
  success: boolean
}): void {
  const index = toolIndexOf(state, input.toolCallId)
  if (index !== undefined) {
    const current = state.items[index] as ToolTimelineItem
    replaceAt(state, { ...current, result: input.result, success: input.success }, index)
    return
  }
  const id = `tool:${input.toolCallId}`
  const item: ToolTimelineItem = {
    kind: 'tool',
    id,
    toolCallId: input.toolCallId,
    turnId: input.turnId,
    name: null,
    arguments: null,
    result: input.result,
    success: input.success,
    seq: null,
  }
  state.items.push(item)
  state.toolByCallId.set(input.toolCallId, state.items.length - 1)
  state.byId.set(id, state.items.length - 1)
}

function upsertPending(state: AgentTimelineState, pending: CanvasAgentPendingJobDto): void {
  const id = `pending:${pending.id}`
  const index = pendingIndexOf(state, pending.id)
  if (index !== undefined) {
    replaceAt(state, { kind: 'pending', id, pending }, index)
    return
  }
  state.items.push({ kind: 'pending', id, pending })
  state.pendingById.set(pending.id, state.items.length - 1)
  state.byId.set(id, state.items.length - 1)
}

/** Drop a provisional assistant segment once the persisted copy of the same text
 *  exists for that turn (the `done` message, or a replayed history page). */
function dropReconciledProvisional(state: AgentTimelineState): void {
  const persisted: Array<{ turnId: string | null; text: string }> = []
  for (const item of state.items) {
    if (item.kind === 'assistant' && !item.provisional) persisted.push({ turnId: item.turnId, text: item.text })
  }
  if (persisted.length === 0) return
  const keep = state.items.filter((item) => !(
    item.kind === 'assistant'
    && item.provisional
    && persisted.some((message) => message.turnId === item.turnId && message.text === item.text)
  ))
  if (keep.length === state.items.length) return
  state.items = keep
  state.byId = new Map()
  state.toolByCallId = new Map()
  state.pendingById = new Map()
  for (const [index, item] of state.items.entries()) {
    state.byId.set(item.id, index)
    if (item.kind === 'tool') state.toolByCallId.set(item.toolCallId, index)
    if (item.kind === 'pending') state.pendingById.set(item.pending.id, index)
  }
}

/** Append an optimistic user message. Its id is the request `messageId`, which the
 *  server persists verbatim, so history merges later update the same item. */
export function appendUserMessage(state: AgentTimelineState, input: {
  id: string
  text: string
  turnId?: string | null
  contextSummary?: CanvasAgentStructuredContext
  createdAt?: string | null
}): AgentTimelineState {
  const next = clone(state)
  upsertMessage(next, {
    kind: 'user',
    id: `msg:${input.id}`,
    text: input.text,
    turnId: input.turnId ?? null,
    seq: null,
    ...(input.contextSummary ? { contextSummary: input.contextSummary } : {}),
    createdAt: input.createdAt ?? null,
  })
  return next
}

/** Reduce one live stream event into the timeline. Pure: returns a new state and
 *  never mutates the input. */
export function applyAgentTimelineEvent(state: AgentTimelineState, event: AgentStreamEvent): AgentTimelineState {
  const next = clone(state)
  switch (event.type) {
    case 'text_delta': {
      const key = `p:${event.turnId}:${nextCounter(next, event.turnId)}`
      next.items.push({ kind: 'assistant', id: key, text: event.delta, turnId: event.turnId, seq: null, provisional: true, createdAt: null })
      next.byId.set(key, next.items.length - 1)
      break
    }
    case 'tool_call':
      upsertToolCall(next, { toolCallId: event.toolCall.id, turnId: event.turnId, seq: null, name: event.toolCall.name, args: event.toolCall.arguments })
      break
    case 'tool_result':
      upsertToolResult(next, { toolCallId: event.toolCallId, turnId: event.turnId, result: event.result, success: event.success })
      break
    case 'canvas_ops': {
      const key = `ops:${event.turnId}:${nextCounter(next, event.turnId)}`
      next.items.push({ kind: 'canvas_ops', id: key, turnId: event.turnId, ops: event.ops, baseRevision: event.baseRevision })
      next.byId.set(key, next.items.length - 1)
      break
    }
    case 'pending_jobs':
      for (const pending of event.pendingJobs) upsertPending(next, pending)
      break
    case 'confirm_required':
      upsertPending(next, event.pending)
      break
    case 'done': {
      mergeMessage(next, event.message, event.turnId)
      dropReconciledProvisional(next)
      break
    }
    case 'error': {
      const key = `err:${event.turnId}:${nextCounter(next, event.turnId)}`
      next.items.push({ kind: 'error', id: key, turnId: event.turnId, code: event.code, message: event.message, retryable: event.retryable })
      next.byId.set(key, next.items.length - 1)
      break
    }
  }
  return next
}

export function reduceAgentEvents(events: readonly AgentStreamEvent[], base: AgentTimelineState = createAgentTimeline()): AgentTimelineState {
  return events.reduce((state, event) => applyAgentTimelineEvent(state, event), base)
}

function mergeMessage(state: AgentTimelineState, message: AgentMessageDto, turnIdFallback?: string): void {
  const turnId = message.turnId ?? turnIdFallback ?? null
  if (message.role === 'tool') {
    // Tool messages are not prose: they attach their result to the grouped call.
    const parsed = parseToolResult(message.content)
    if (parsed) upsertToolResult(state, { toolCallId: parsed.toolCallId, turnId: turnId ?? '', result: parsed.result, success: parsed.success })
    return
  }
  if (message.role === 'user') {
    upsertMessage(state, {
      kind: 'user',
      id: `msg:${message.id}`,
      text: message.content,
      turnId,
      seq: message.seq,
      ...(message.contextSummary ? { contextSummary: message.contextSummary } : {}),
      createdAt: message.createdAt,
    })
    return
  }
  upsertMessage(state, {
    kind: 'assistant',
    id: `msg:${message.id}`,
    text: message.content,
    turnId,
    seq: message.seq,
    provisional: false,
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.ops?.length ? { ops: message.ops } : {}),
    createdAt: message.createdAt,
  })
  for (const call of message.toolCalls ?? []) {
    upsertToolCall(state, { toolCallId: call.id, turnId: turnId ?? '', seq: message.seq, name: call.name, args: call.arguments })
  }
}

function parseToolResult(content: string): { toolCallId: string; result: JsonValue; success: boolean } | null {
  try {
    const parsed = JSON.parse(content) as { toolCallId?: unknown; result?: unknown; success?: unknown }
    if (typeof parsed.toolCallId !== 'string') return null
    return { toolCallId: parsed.toolCallId, result: (parsed.result ?? null) as JsonValue, success: parsed.success === true }
  } catch {
    return null
  }
}

/**
 * Merge one persisted history page + its pending list. Idempotent: replaying the
 * same page (or re-fetching after a refresh) updates existing items in place
 * instead of duplicating them. Order is by server `seq`; pending jobs are grouped
 * by id.
 */
export function mergeHistoryPage(
  state: AgentTimelineState,
  messages: readonly AgentMessageDto[],
  pendingJobs: readonly CanvasAgentPendingJobDto[] = [],
): AgentTimelineState {
  const next = clone(state)
  for (const message of messages) mergeMessage(next, message)
  for (const pending of pendingJobs) upsertPending(next, pending)
  dropReconciledProvisional(next)
  return next
}

/** Apply a confirm/apply response's pending snapshot to the timeline (status and
 *  eventual jobId), keeping the confirmation card identity stable. */
export function applyPendingSnapshot(state: AgentTimelineState, pending: CanvasAgentPendingJobDto): AgentTimelineState {
  const next = clone(state)
  upsertPending(next, pending)
  return next
}

// ----- Presentation helpers (pure, unit-tested) -----

export function pendingStatusLabel(status: CanvasAgentPendingJobDto['status']): string {
  switch (status) {
    case 'pending': return '等待确认'
    case 'submitting': return '正在提交'
    case 'submitted': return '已提交生成'
    case 'rejected': return '已拒绝'
    case 'expired': return '已失效'
    default: return '未知状态'
  }
}

/** A confirmation card is immutable. Confirm/reject only apply while the proposal
 *  is still actionable: pending, not past its expiry, and not already in flight. */
export function canConfirmPending(pending: CanvasAgentPendingJobDto, now: number): boolean {
  if (pending.status !== 'pending') return false
  const expiresAt = Date.parse(pending.expiresAt)
  return Number.isFinite(expiresAt) ? expiresAt > now : true
}

export interface AgentAvailability {
  /** A new turn may be started. */
  canGenerate: boolean
  /** Human-readable reason when disabled, else `null`. */
  notice: string | null
  /** History, library and downloads stay usable even when generation is off. */
  historyUsable: boolean
}

// ----- Managed-apply helpers (pure, unit-tested) -----

/** Pending proposals that still block an apply: the scene must not move while a
 *  confirmation is outstanding, or the next confirm would target a stale revision. */
export function hasActionablePending(state: AgentTimelineState): boolean {
  return state.items.some(
    (item) => item.kind === 'pending'
      && (item.pending.status === 'pending' || item.pending.status === 'submitting'),
  )
}

/** Whether a turn produced scene ops. Live ops arrive as `canvas_ops` events; a
 *  replayed `done`/history assistant message carries them on the message itself,
 *  so a turn recovered after a disconnect is still applyable without a resend. */
export function turnHasCanvasOps(state: AgentTimelineState, turnId: string, messageOpsCount = 0): boolean {
  if (messageOpsCount > 0) return true
  return state.items.some((item) => (
    (item.kind === 'canvas_ops' && item.turnId === turnId && item.ops.length > 0)
    || (item.kind === 'assistant' && item.turnId === turnId && (item.ops?.length ?? 0) > 0)
  ))
}

/**
 * After a turn completes with agent-managed ops and no pending left, the turn's
 * proposal is safe to apply. `false` while any proposal is still awaiting a
 * decision — applying early would advance the revision and invalidate it.
 */
export function shouldApplyTurn(state: AgentTimelineState, turnId: string, messageOpsCount = 0): boolean {
  return turnHasCanvasOps(state, turnId, messageOpsCount) && !hasActionablePending(state)
}

/**
 * Turns that produced canvas ops, in the order they were observed. A live
 * `canvas_ops` event and a persisted assistant message carrying the same ops both
 * name the same turn, so the id is de-duplicated before it is returned.
 */
export function unappliedOpsTurnIds(state: AgentTimelineState): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const item of state.items) {
    const turnId = item.kind === 'canvas_ops'
      ? item.turnId
      : item.kind === 'assistant' && (item.ops?.length ?? 0) > 0 ? item.turnId : null
    if (!turnId || seen.has(turnId)) continue
    seen.add(turnId)
    ids.push(turnId)
  }
  return ids
}

/**
 * The next turn a bounded post-history apply recovery may commit, or `null`.
 *
 * Recovery exists for the disconnect/reload case: a completed agent-managed turn
 * whose live `done` never reached the client still shows its ops in history, and
 * nothing else would ever apply them. It is deliberately conservative —
 *
 * - `null` while any proposal is still actionable: applying would advance the
 *   revision under an unresolved confirmation and invalidate it;
 * - skipped once a turn id is in `attempted`, so a turn is never applied twice in
 *   one session, no matter how many refetches re-merge its page;
 * - at most the *newest* un-attempted ops turn, so one history load can only ever
 *   issue a single recovery apply instead of walking the whole conversation.
 */
export function planApplyRecovery(state: AgentTimelineState, attempted: ReadonlySet<string>): string | null {
  if (hasActionablePending(state)) return null
  const candidates = unappliedOpsTurnIds(state)
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const turnId = candidates[index]!
    if (attempted.has(turnId)) continue
    if (shouldApplyTurn(state, turnId)) return turnId
  }
  return null
}

/** What to show after an apply attempt: the real applied/revision/op-count, or why
 *  the server refused it. */
export interface ApplyFeedback {
  applied: boolean
  revision: number
  opCount: number
  message: string
}

export function describeApplyResult(result: CanvasAgentApplyResultDto): ApplyFeedback {
  return {
    applied: result.applied,
    revision: result.revision,
    opCount: result.ops.length,
    message: result.applied
      ? `已提交画布改动（版本 ${result.revision}，共 ${result.ops.length} 项）。`
      : `画布改动未应用（当前版本 ${result.revision}）。`,
  }
}

/** The real reason an apply failed. A conflict means the canvas moved under us and
 *  the proposal is stale; it must not be silently re-applied or merged. */
export function applyFailureMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : null
  if (code === 'CANVAS_AGENT_APPLY_CONFLICT') {
    return '画布版本已变化，改动未提交。请刷新后重新规划。'
  }
  if (error instanceof Error && error.message) return `提交画布改动失败：${error.message}`
  return '提交画布改动失败，请稍后重试。'
}

/** Derive the Agent availability state. A disabled/not-configured Agent never
 *  falls back to the manual generation path — it only reports why creation is off. */
export function resolveAgentAvailability(status: CanvasAgentStatusDto | undefined): AgentAvailability {
  if (!status) {
    return { canGenerate: false, notice: '正在检查 Agent 可用状态…', historyUsable: true }
  }
  if (status.available) {
    return { canGenerate: true, notice: null, historyUsable: true }
  }
  const notice = status.reason === 'disabled'
    ? 'Agent 未启用，仍可查看历史、图库并下载作品，但不能发起新生成。'
    : status.reason === 'not_configured'
      ? 'Agent 尚未配置语言模型，仍可查看历史、图库并下载作品，但不能发起新生成。'
      : 'Agent 配置的模型不受支持，仍可查看历史、图库并下载作品。'
  return { canGenerate: false, notice, historyUsable: true }
}
