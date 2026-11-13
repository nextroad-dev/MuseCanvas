// Canvas Agent 时间线纯状态机 + 提案确认状态 + apply 规划。
//
// 三条身份规则让「实时 SSE」与「持久化 history」能收敛到同一时间线而不重复：
// 1. 持久消息按服务端 `message.id` 归并，按单调 `seq` 排序（翻旧页时前插）。
// 2. 实时 `text_delta` 是临时段落（`p:<turnId>:<n>`），终态 `done` 或 history
//    提供同 turn 同文本的持久消息后丢弃。
// 3. 工具调用按 `toolCallId`、提案按 pending id 归并；SSE `eventId` 会重放，绝不作为身份。
//
// 纯模块：仅 `import type`，可在 node --test 下直接运行。

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

// ---------------------------------------------------------------------------
// 时间线
// ---------------------------------------------------------------------------

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
  /** 实时 delta 段落（尚未与持久消息对齐）。 */
  provisional: boolean
  usage?: CanvasAgentUsageDto
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
  /** 每 turn 的临时 key 计数（delta / ops / error）。 */
  counters: Record<string, number>
}

export function createAgentTimeline(): AgentTimelineState {
  return { items: [], counters: {} }
}

/** 登录用户变化：hook 用它中止流并清掉上一个用户的时间线与缓存。 */
export function agentScopeChanged(
  previousActorId: string | null | undefined,
  nextActorId: string | null | undefined,
): boolean {
  return (previousActorId || null) !== (nextActorId || null)
}

function clone(state: AgentTimelineState): AgentTimelineState {
  return { items: state.items.slice(), counters: { ...state.counters } }
}

function nextCounter(state: AgentTimelineState, turnId: string): number {
  const value = (state.counters[turnId] ?? 0) + 1
  state.counters[turnId] = value
  return value
}

function seqOf(item: TimelineItem): number | null {
  return 'seq' in item ? item.seq : null
}

/** 持久消息按 seq 升序插入；实时项（seq=null）追加到末尾。 */
function insertOrdered(state: AgentTimelineState, item: TimelineItem): void {
  const seq = seqOf(item)
  let at = state.items.length
  if (seq !== null) {
    for (let index = 0; index < state.items.length; index += 1) {
      const existing = seqOf(state.items[index]!)
      if (existing !== null && existing > seq) {
        at = index
        break
      }
    }
  }
  state.items.splice(at, 0, item)
}

function upsertMessage(state: AgentTimelineState, item: UserTimelineItem | AssistantTimelineItem): void {
  const index = state.items.findIndex((candidate) => candidate.id === item.id)
  if (index >= 0) state.items[index] = item
  else insertOrdered(state, item)
}

function upsertToolCall(
  state: AgentTimelineState,
  input: { toolCallId: string; turnId: string; seq: number | null; name?: string; args?: JsonObject },
): void {
  const index = state.items.findIndex(
    (candidate) => candidate.kind === 'tool' && candidate.toolCallId === input.toolCallId,
  )
  if (index >= 0) {
    const current = state.items[index] as ToolTimelineItem
    state.items[index] = {
      ...current,
      name: input.name ?? current.name,
      arguments: input.args ?? current.arguments,
      seq: current.seq ?? input.seq,
    }
    return
  }
  state.items.push({
    kind: 'tool',
    id: `tool:${input.toolCallId}`,
    toolCallId: input.toolCallId,
    turnId: input.turnId,
    name: input.name ?? null,
    arguments: input.args ?? null,
    result: null,
    success: null,
    seq: input.seq,
  })
}

function upsertToolResult(
  state: AgentTimelineState,
  input: { toolCallId: string; turnId: string; result: JsonValue; success: boolean },
): void {
  const index = state.items.findIndex(
    (candidate) => candidate.kind === 'tool' && candidate.toolCallId === input.toolCallId,
  )
  if (index >= 0) {
    const current = state.items[index] as ToolTimelineItem
    state.items[index] = { ...current, result: input.result, success: input.success }
    return
  }
  state.items.push({
    kind: 'tool',
    id: `tool:${input.toolCallId}`,
    toolCallId: input.toolCallId,
    turnId: input.turnId,
    name: null,
    arguments: null,
    result: input.result,
    success: input.success,
    seq: null,
  })
}

function upsertPending(state: AgentTimelineState, pending: CanvasAgentPendingJobDto): void {
  const id = `pending:${pending.id}`
  const index = state.items.findIndex((candidate) => candidate.kind === 'pending' && candidate.pending.id === pending.id)
  if (index >= 0) {
    state.items[index] = { kind: 'pending', id, pending }
    return
  }
  state.items.push({ kind: 'pending', id, pending })
}

/** 持久副本已出现时丢弃同 turn 同文本的临时段落。 */
function dropReconciledProvisional(state: AgentTimelineState): void {
  const persisted = state.items.filter(
    (item): item is AssistantTimelineItem => item.kind === 'assistant' && !item.provisional,
  )
  if (persisted.length === 0) return
  state.items = state.items.filter(
    (item) =>
      !(
        item.kind === 'assistant' &&
        item.provisional &&
        persisted.some((message) => message.turnId === item.turnId && message.text === item.text)
      ),
  )
}

/** 乐观追加用户消息；id 就是请求 messageId，history 归并时会覆盖同一条。 */
export function appendUserMessage(
  state: AgentTimelineState,
  input: {
    id: string
    text: string
    turnId?: string | null
    contextSummary?: CanvasAgentStructuredContext
    createdAt?: string | null
  },
): AgentTimelineState {
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

/** 把一个实时事件归并进时间线（纯函数）。 */
export function applyAgentTimelineEvent(
  state: AgentTimelineState,
  event: AgentStreamEvent,
): AgentTimelineState {
  const next = clone(state)
  switch (event.type) {
    case 'text_delta': {
      const id = `p:${event.turnId}:${nextCounter(next, event.turnId)}`
      next.items.push({
        kind: 'assistant',
        id,
        text: event.delta,
        turnId: event.turnId,
        seq: null,
        provisional: true,
        createdAt: null,
      })
      break
    }
    case 'tool_call':
      upsertToolCall(next, {
        toolCallId: event.toolCall.id,
        turnId: event.turnId,
        seq: null,
        name: event.toolCall.name,
        args: event.toolCall.arguments,
      })
      break
    case 'tool_result':
      upsertToolResult(next, {
        toolCallId: event.toolCallId,
        turnId: event.turnId,
        result: event.result,
        success: event.success,
      })
      break
    case 'canvas_ops': {
      const id = `ops:${event.turnId}:${nextCounter(next, event.turnId)}`
      next.items.push({ kind: 'canvas_ops', id, turnId: event.turnId, ops: event.ops, baseRevision: event.baseRevision })
      break
    }
    case 'pending_jobs':
      for (const pending of event.pendingJobs) upsertPending(next, pending)
      break
    case 'confirm_required':
      upsertPending(next, event.pending)
      break
    case 'done':
      mergeMessage(next, event.message, event.turnId)
      dropReconciledProvisional(next)
      break
    case 'error': {
      const id = `err:${event.turnId}:${nextCounter(next, event.turnId)}`
      next.items.push({
        kind: 'error',
        id,
        turnId: event.turnId,
        code: event.code,
        message: event.message,
        retryable: event.retryable,
      })
      break
    }
  }
  return next
}

export function reduceAgentEvents(
  events: readonly AgentStreamEvent[],
  base: AgentTimelineState = createAgentTimeline(),
): AgentTimelineState {
  return events.reduce((state, event) => applyAgentTimelineEvent(state, event), base)
}

function mergeMessage(state: AgentTimelineState, message: AgentMessageDto, turnIdFallback?: string): void {
  const turnId = message.turnId ?? turnIdFallback ?? null
  if (message.role === 'tool') {
    const parsed = parseToolResult(message.content)
    if (parsed) {
      upsertToolResult(state, { toolCallId: parsed.toolCallId, turnId: turnId ?? '', result: parsed.result, success: parsed.success })
    }
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
    return {
      toolCallId: parsed.toolCallId,
      result: (parsed.result ?? null) as JsonValue,
      success: parsed.success === true,
    }
  } catch {
    return null
  }
}

/** 合并一页持久 history（幂等：重复拉取同一页只更新不重复）。 */
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

/** 确认/apply 响应里的最新提案快照写回时间线，保持卡片身份稳定。 */
export function applyPendingSnapshot(
  state: AgentTimelineState,
  pending: CanvasAgentPendingJobDto,
): AgentTimelineState {
  const next = clone(state)
  upsertPending(next, pending)
  return next
}

// ---------------------------------------------------------------------------
// 展示与可用性
// ---------------------------------------------------------------------------

export function pendingStatusLabel(status: CanvasAgentPendingJobDto['status']): string {
  switch (status) {
    case 'pending':
      return '等待确认'
    case 'submitting':
      return '正在提交'
    case 'submitted':
      return '已提交生成'
    case 'rejected':
      return '已拒绝'
    case 'expired':
      return '已失效'
    default:
      return '未知状态'
  }
}

/** 提案不可变：只有 pending 且未过期才可确认/拒绝。 */
export function canConfirmPending(pending: CanvasAgentPendingJobDto, now: number): boolean {
  if (pending.status !== 'pending') return false
  const expiresAt = Date.parse(pending.expiresAt)
  return Number.isFinite(expiresAt) ? expiresAt > now : true
}

export interface AgentAvailability {
  canGenerate: boolean
  notice: string | null
  historyUsable: boolean
}

/** Agent 可用状态：不可用时只说明原因，不回落手动生成。 */
export function resolveAgentAvailability(status: CanvasAgentStatusDto | undefined): AgentAvailability {
  if (!status) return { canGenerate: false, notice: '正在检查 Agent 可用状态…', historyUsable: true }
  if (status.available) return { canGenerate: true, notice: null, historyUsable: true }
  const notice =
    status.reason === 'disabled'
      ? 'Agent 未启用，仍可查看历史、图库并下载作品，但不能发起新生成。'
      : status.reason === 'not_configured'
        ? 'Agent 尚未配置语言模型，仍可查看历史、图库并下载作品，但不能发起新生成。'
        : 'Agent 配置的模型不受支持，仍可查看历史、图库并下载作品。'
  return { canGenerate: false, notice, historyUsable: true }
}

// ---------------------------------------------------------------------------
// 画布 apply 规划
// ---------------------------------------------------------------------------

export function hasActionablePending(state: AgentTimelineState): boolean {
  return state.items.some(
    (item) =>
      item.kind === 'pending' && (item.pending.status === 'pending' || item.pending.status === 'submitting'),
  )
}

export function turnHasCanvasOps(state: AgentTimelineState, turnId: string, messageOpsCount = 0): boolean {
  if (messageOpsCount > 0) return true
  return state.items.some(
    (item) =>
      (item.kind === 'canvas_ops' && item.turnId === turnId && item.ops.length > 0) ||
      (item.kind === 'assistant' && item.turnId === turnId && (item.ops?.length ?? 0) > 0),
  )
}

/** 终态 turn 且没有未决提案时，agent-managed 改动才可 apply。 */
export function shouldApplyTurn(state: AgentTimelineState, turnId: string, messageOpsCount = 0): boolean {
  return turnHasCanvasOps(state, turnId, messageOpsCount) && !hasActionablePending(state)
}

/** 产出过 ops 的 turn（去重、按出现顺序）。 */
export function unappliedOpsTurnIds(state: AgentTimelineState): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const item of state.items) {
    const turnId =
      item.kind === 'canvas_ops'
        ? item.turnId
        : item.kind === 'assistant' && (item.ops?.length ?? 0) > 0
          ? item.turnId
          : null
    if (!turnId || seen.has(turnId)) continue
    seen.add(turnId)
    ids.push(turnId)
  }
  return ids
}

/**
 * 断线/刷新后的有界 apply 恢复：只挑最新未尝试的 ops turn，
 * 有任何未决提案时不做（否则在提案未决时推进 revision 会使其失效）。
 */
export function planApplyRecovery(
  state: AgentTimelineState,
  attempted: ReadonlySet<string>,
): string | null {
  if (hasActionablePending(state)) return null
  const candidates = unappliedOpsTurnIds(state)
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const turnId = candidates[index]!
    if (attempted.has(turnId)) continue
    if (shouldApplyTurn(state, turnId)) return turnId
  }
  return null
}

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

export function applyFailureMessage(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : null
  if (code === 'CANVAS_AGENT_APPLY_CONFLICT') {
    return '画布版本已变化，改动未提交。请刷新后重新规划。'
  }
  if (error instanceof Error && error.message) return `提交画布改动失败：${error.message}`
  return '提交画布改动失败，请稍后重试。'
}

// ---------------------------------------------------------------------------
// 提案确认状态机
// ---------------------------------------------------------------------------

export type ConfirmationAction = 'confirm' | 'reject'
export type ConfirmationPhase =
  | 'idle'
  | 'submitting'
  | 'submitted'
  | 'rejected'
  | 'expired'
  | 'conflict'
  | 'error'

export interface PendingConfirmation {
  pendingId: string
  action: ConfirmationAction | null
  phase: ConfirmationPhase
  message: string | null
  /** 提案已失效/冲突：必须发新请求，不能重试旧 pending。 */
  requiresNewProposal: boolean
}

export type ConfirmationMap = Record<string, PendingConfirmation>

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : null
}

export interface ConfirmErrorInfo {
  phase: ConfirmationPhase
  message: string
  requiresNewProposal: boolean
}

/** 分类确认失败：冲突/过期/不存在都意味着必须新提案，不能静默重试。 */
export function classifyConfirmError(error: unknown): ConfirmErrorInfo {
  const code = errorCodeOf(error)
  if (code === 'CANVAS_AGENT_CONFIRM_CONFLICT') {
    return { phase: 'conflict', message: '提案的输入或画布版本已变化，无法再确认。请发送新的请求生成新提案。', requiresNewProposal: true }
  }
  if (code === 'CANVAS_AGENT_CONFIRM_EXPIRED') {
    return { phase: 'expired', message: '提案已过期，无法再确认。请发送新的请求生成新提案。', requiresNewProposal: true }
  }
  if (code === 'CANVAS_AGENT_CONFIRM_NOT_FOUND') {
    return { phase: 'expired', message: '提案不存在或已被处理，请刷新历史后发送新的请求。', requiresNewProposal: true }
  }
  const message = error instanceof Error && error.message ? error.message : '确认失败，请稍后重试。'
  return { phase: 'error', message, requiresNewProposal: false }
}

export function createConfirmationState(): ConfirmationMap {
  return {}
}

export function beginConfirmation(
  map: ConfirmationMap,
  pendingId: string,
  action: ConfirmationAction,
): ConfirmationMap {
  return {
    ...map,
    [pendingId]: { pendingId, action, phase: 'submitting', message: null, requiresNewProposal: false },
  }
}

function phaseFromStatus(status: CanvasAgentPendingJobDto['status']): ConfirmationPhase {
  switch (status) {
    case 'submitting':
      return 'submitting'
    case 'submitted':
      return 'submitted'
    case 'rejected':
      return 'rejected'
    case 'expired':
      return 'expired'
    default:
      return 'idle'
  }
}

export function confirmationSucceeded(
  map: ConfirmationMap,
  result: { pending: CanvasAgentPendingJobDto },
): ConfirmationMap {
  const previous = map[result.pending.id]
  return {
    ...map,
    [result.pending.id]: {
      pendingId: result.pending.id,
      action: previous?.action ?? null,
      phase: phaseFromStatus(result.pending.status),
      message: null,
      requiresNewProposal: false,
    },
  }
}

export function confirmationFailed(
  map: ConfirmationMap,
  pendingId: string,
  error: unknown,
): ConfirmationMap {
  const previous = map[pendingId]
  const info = classifyConfirmError(error)
  return {
    ...map,
    [pendingId]: {
      pendingId,
      action: previous?.action ?? null,
      phase: info.phase,
      message: info.message,
      requiresNewProposal: info.requiresNewProposal,
    },
  }
}

export function confirmationFor(map: ConfirmationMap, pendingId: string): PendingConfirmation {
  return (
    map[pendingId] ?? {
      pendingId,
      action: null,
      phase: 'idle',
      message: null,
      requiresNewProposal: false,
    }
  )
}

export function isConfirmationBusy(map: ConfirmationMap, pendingId: string): boolean {
  return confirmationFor(map, pendingId).phase === 'submitting'
}
