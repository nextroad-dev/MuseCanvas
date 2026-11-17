// Agent Core V1 时间线纯状态机：严格以 BigInt 比较 PostgreSQL bigint 游标与单调 revision。
//
// 三条收敛规则确保「快照 + 历史分页 + SSE 重放」可任意重连而绝不乱序或重复：
// 1. item 按 `item.id` 去重，按 `BigInt(sequence)` 严格升序排列。
// 2. turn / tool / approval 仅在 `BigInt(next.revision) >= BigInt(prev.revision)` 时更新（同 revision 不回退终态）。
// 3. `ready` 帧不推进 `eventCursor`，仅持久事件与 `heartbeat` 单调推进游标；`resync.required` 标记需重建快照。
//
// 纯模块：仅 `import type`，零 React/DOM 依赖，可在 `node --test` 下直接运行。

import type {
  AgentApprovalSummaryDTO,
  AgentDecimal,
  AgentEventEnvelope,
  AgentItemDTO,
  AgentItemsPageDTO,
  AgentSessionDTO,
  AgentSessionSnapshotDTO,
  AgentToolSummaryDTO,
  AgentTransportFrame,
  AgentTurnDTO,
} from '@musecanvas/contracts'

export type AgentResyncReason = 'retention' | 'backlog' | 'unavailable'

export interface AgentConsoleScope {
  actorId?: string | null
  sessionId?: string | null
}

export interface AgentConsoleTimelineState {
  session: AgentSessionDTO | null
  activeTurn: AgentTurnDTO | null
  items: AgentItemDTO[]
  tools: Record<string, AgentToolSummaryDTO>
  approvals: Record<string, AgentApprovalSummaryDTO>
  eventCursor: AgentDecimal
  lastItemSequence: AgentDecimal
  itemsHasMore: boolean
  nextItemsCursor: AgentDecimal
  resyncRequired: AgentResyncReason | null
}

const TERMINAL_TURN_STATUSES = new Set<AgentTurnDTO['status']>(['completed', 'failed', 'cancelled'])

export function createEmptyAgentConsoleState(): AgentConsoleTimelineState {
  return {
    session: null,
    activeTurn: null,
    items: [],
    tools: {},
    approvals: {},
    eventCursor: '0',
    lastItemSequence: '0',
    itemsHasMore: false,
    nextItemsCursor: '0',
    resyncRequired: null,
  }
}

export function isTurnActive(turn: AgentTurnDTO | null | undefined): boolean {
  if (!turn) return false
  return !TERMINAL_TURN_STATUSES.has(turn.status)
}

function normalizeScopeId(value: string | null | undefined): string | null {
  return value ? value : null
}

/** 比较会话/用户作用域是否变更（用于中止旧 SSE 流与丢弃过期回调）。 */
export function agentConsoleScopeChanged(
  prev: AgentConsoleScope | string | null | undefined,
  next: AgentConsoleScope | string | null | undefined,
): boolean {
  if (typeof prev === 'string' || prev === null || prev === undefined || typeof next === 'string' || next === null || next === undefined) {
    if (typeof prev === 'object' && prev !== null) {
      return normalizeScopeId(prev.actorId) !== normalizeScopeId(typeof next === 'string' ? next : null) || normalizeScopeId(prev.sessionId) !== null
    }
    if (typeof next === 'object' && next !== null) {
      return normalizeScopeId(typeof prev === 'string' ? prev : null) !== normalizeScopeId(next.actorId) || normalizeScopeId(next.sessionId) !== null
    }
    return normalizeScopeId(prev) !== normalizeScopeId(next)
  }
  return (
    normalizeScopeId(prev.actorId) !== normalizeScopeId(next.actorId) ||
    normalizeScopeId(prev.sessionId) !== normalizeScopeId(next.sessionId)
  )
}

function compareDecimal(a: AgentDecimal, b: AgentDecimal): number {
  const left = BigInt(a)
  const right = BigInt(b)
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function maxDecimal(a: AgentDecimal, b: AgentDecimal): AgentDecimal {
  return compareDecimal(a, b) >= 0 ? a : b
}

function mergeItems(existing: readonly AgentItemDTO[], incoming: readonly AgentItemDTO[]): AgentItemDTO[] {
  const byId = new Map<string, AgentItemDTO>()
  for (const item of existing) byId.set(item.id, item)
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()].sort((a, b) => compareDecimal(a.sequence, b.sequence) || a.id.localeCompare(b.id))
}

function shouldAcceptTurn(prev: AgentTurnDTO | null, next: AgentTurnDTO): boolean {
  if (!prev || prev.id !== next.id) return true
  const cmp = compareDecimal(next.revision, prev.revision)
  if (cmp > 0) return true
  if (cmp < 0) return false
  // Equal revision must never regress a terminal turn back to non-terminal.
  if (!isTurnActive(prev) && isTurnActive(next)) return false
  return true
}

function mergeTool(
  tools: Record<string, AgentToolSummaryDTO>,
  incoming: AgentToolSummaryDTO,
): Record<string, AgentToolSummaryDTO> {
  const prev = tools[incoming.id]
  if (prev && compareDecimal(incoming.revision, prev.revision) < 0) return tools
  return { ...tools, [incoming.id]: incoming }
}

function mergeApproval(
  approvals: Record<string, AgentApprovalSummaryDTO>,
  incoming: AgentApprovalSummaryDTO,
): Record<string, AgentApprovalSummaryDTO> {
  const prev = approvals[incoming.id]
  if (prev) {
    const cmp = compareDecimal(incoming.revision, prev.revision)
    if (cmp < 0) return approvals
    if (cmp === 0 && prev.status !== 'pending' && incoming.status === 'pending') return approvals
  }
  return { ...approvals, [incoming.id]: incoming }
}

function mergeToolsBatch(
  base: Record<string, AgentToolSummaryDTO>,
  list: readonly AgentToolSummaryDTO[],
): Record<string, AgentToolSummaryDTO> {
  let next = { ...base }
  for (const tool of list) next = mergeTool(next, tool)
  return next
}

function mergeApprovalsBatch(
  base: Record<string, AgentApprovalSummaryDTO>,
  list: readonly AgentApprovalSummaryDTO[],
): Record<string, AgentApprovalSummaryDTO> {
  let next = { ...base }
  for (const approval of list) next = mergeApproval(next, approval)
  return next
}

function pickNextTurnOnSnapshot(
  prevTurn: AgentTurnDTO | null,
  snapshotTurn: AgentTurnDTO | null,
  snapshotIsAtLeastAsFresh: boolean,
  isResyncOrFreshSession: boolean,
): AgentTurnDTO | null {
  if (isResyncOrFreshSession) {
    if (snapshotTurn && prevTurn && snapshotTurn.id === prevTurn.id && !shouldAcceptTurn(prevTurn, snapshotTurn)) {
      return prevTurn
    }
    return snapshotTurn
  }
  if (!snapshotIsAtLeastAsFresh) {
    if (snapshotTurn && prevTurn && snapshotTurn.id === prevTurn.id && shouldAcceptTurn(prevTurn, snapshotTurn)) {
      return snapshotTurn
    }
    return prevTurn
  }
  if (snapshotTurn === null) return null
  if (prevTurn && prevTurn.id === snapshotTurn.id) {
    return shouldAcceptTurn(prevTurn, snapshotTurn) ? snapshotTurn : prevTurn
  }
  return snapshotTurn
}

/** 合并服务端会话快照；切换会话或 resync 时重新对齐基线，同会话下保持游标与 revision 单调。 */
export function applyAgentSnapshot(
  state: AgentConsoleTimelineState,
  snapshot: AgentSessionSnapshotDTO,
): AgentConsoleTimelineState {
  const sameSession = state.session?.id === snapshot.session.id
  const isResync = sameSession && state.resyncRequired !== null
  const freshOrResync = !sameSession || isResync
  const snapshotIsAtLeastAsFresh = !sameSession || compareDecimal(snapshot.eventCursor, state.eventCursor) >= 0

  const baseItems = sameSession ? state.items : []
  const items = mergeItems(baseItems, snapshot.items)

  const baseTools = sameSession ? state.tools : {}
  const baseApprovals = sameSession ? state.approvals : {}
  const tools = mergeToolsBatch(baseTools, snapshot.tools)
  const approvals = mergeApprovalsBatch(baseApprovals, snapshot.approvals)

  const eventCursor = freshOrResync
    ? snapshot.eventCursor
    : maxDecimal(state.eventCursor, snapshot.eventCursor)

  const lastMergedSequence = items.length > 0 ? items[items.length - 1]!.sequence : '0'
  const lastItemSequence = sameSession
    ? maxDecimal(maxDecimal(state.lastItemSequence, snapshot.lastItemSequence), lastMergedSequence)
    : maxDecimal(snapshot.lastItemSequence, lastMergedSequence)

  const advanceCursorMeta =
    freshOrResync || compareDecimal(snapshot.nextItemsCursor, state.nextItemsCursor) >= 0

  return {
    session: snapshotIsAtLeastAsFresh || !state.session ? snapshot.session : state.session,
    activeTurn: pickNextTurnOnSnapshot(
      sameSession ? state.activeTurn : null,
      snapshot.activeTurn,
      snapshotIsAtLeastAsFresh,
      freshOrResync,
    ),
    items,
    tools,
    approvals,
    eventCursor,
    lastItemSequence,
    itemsHasMore: advanceCursorMeta ? snapshot.itemsHasMore : state.itemsHasMore,
    nextItemsCursor: advanceCursorMeta ? snapshot.nextItemsCursor : state.nextItemsCursor,
    resyncRequired: null,
  }
}

/** 合并 `GET /items` 分页结果：按 `item.id` 去重并按 `BigInt(sequence)` 升序归并。 */
export function prependOlderAgentItems(
  state: AgentConsoleTimelineState,
  page: AgentItemsPageDTO,
): AgentConsoleTimelineState {
  const items = mergeItems(state.items, page.items)
  const lastMergedSequence = items.length > 0 ? items[items.length - 1]!.sequence : '0'
  return {
    ...state,
    items,
    lastItemSequence: maxDecimal(maxDecimal(state.lastItemSequence, page.lastItemSequence), lastMergedSequence),
    itemsHasMore: page.hasMore,
    nextItemsCursor: page.nextCursor,
  }
}

/** 归并单条持久 SSE 事件（幂等、防跨会话污染、防旧 revision 倒退）。 */
export function applyAgentEvent(
  state: AgentConsoleTimelineState,
  event: AgentEventEnvelope,
): AgentConsoleTimelineState {
  if (state.session && event.sessionId !== state.session.id) return state

  const nextEventCursor = maxDecimal(state.eventCursor, event.cursor)
  let nextSession = state.session
  if (nextSession && compareDecimal(event.cursor, nextSession.nextEventCursor) >= 0) {
    nextSession = {
      ...nextSession,
      nextEventCursor: (BigInt(event.cursor) + 1n).toString() as AgentDecimal,
    }
  }

  switch (event.type) {
    case 'item.created': {
      const item = event.payload.item
      const items = mergeItems(state.items, [item])
      const lastItemSequence = maxDecimal(state.lastItemSequence, item.sequence)
      if (nextSession && compareDecimal(item.sequence, nextSession.nextItemSequence) >= 0) {
        nextSession = {
          ...nextSession,
          nextItemSequence: (BigInt(item.sequence) + 1n).toString() as AgentDecimal,
        }
      }
      return {
        ...state,
        session: nextSession,
        items,
        eventCursor: nextEventCursor,
        lastItemSequence,
      }
    }

    case 'tool.updated': {
      return {
        ...state,
        session: nextSession,
        tools: mergeTool(state.tools, event.payload.tool),
        eventCursor: nextEventCursor,
      }
    }

    case 'approval.required': {
      return {
        ...state,
        session: nextSession,
        approvals: mergeApproval(state.approvals, event.payload.approval),
        eventCursor: nextEventCursor,
      }
    }

    case 'turn.updated': {
      const incoming = event.payload.turn
      let activeTurn = state.activeTurn
      if (!activeTurn) {
        // Ignore stale replay from an older cursor if it somehow arrives after state cleared? No, null -> accept.
        activeTurn = incoming
      } else if (activeTurn.id === incoming.id) {
        if (shouldAcceptTurn(activeTurn, incoming)) activeTurn = incoming
      } else {
        // Different turnId: only switch if incoming is newer than what we've already processed, or current turn is terminal.
        const isStaleReplay = compareDecimal(event.cursor, state.eventCursor) <= 0
        if (!isStaleReplay || !isTurnActive(activeTurn)) {
          activeTurn = incoming
        }
      }

      if (nextSession && activeTurn === incoming) {
        const nextActiveTurnId = isTurnActive(incoming)
          ? incoming.id
          : nextSession.activeTurnId === incoming.id
            ? null
            : nextSession.activeTurnId
        if (
          nextSession.activeTurnId !== nextActiveTurnId ||
          compareDecimal(incoming.inputRevision, nextSession.inputRevision) > 0
        ) {
          nextSession = {
            ...nextSession,
            activeTurnId: nextActiveTurnId,
            inputRevision: maxDecimal(nextSession.inputRevision, incoming.inputRevision),
          }
        }
      }

      return {
        ...state,
        session: nextSession,
        activeTurn,
        eventCursor: nextEventCursor,
      }
    }
  }
}

/** 处理传输层控制帧：`ready` 不跳过未读事件，`heartbeat` 单调校准，`resync.required` 标记重同步。 */
export function applyAgentTransportFrame(
  state: AgentConsoleTimelineState,
  frame: AgentTransportFrame,
): AgentConsoleTimelineState {
  if (state.session && frame.sessionId !== state.session.id) return state

  switch (frame.type) {
    case 'ready':
      return state
    case 'heartbeat': {
      const eventCursor = maxDecimal(state.eventCursor, frame.cursor)
      return eventCursor === state.eventCursor ? state : { ...state, eventCursor }
    }
    case 'resync.required':
      return { ...state, resyncRequired: frame.reason }
  }
}
