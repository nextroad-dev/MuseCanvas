'use client'

// Agent Core V1 前端控制枢纽：会话列表分页、快照拉取、历史项翻页、
// 有限 SSE 自动重连（`live`）与本地时钟推进订阅（`mock`），以及 5 个域变更动作。
// 中止/卸载仅取消事件流，绝不隐式取消后端正在执行的 Turn。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import type {
  AgentApprovalSummaryDTO,
  AgentEventEnvelope,
  AgentItemDTO,
  AgentMessageAcceptedDTO,
  AgentSessionDTO,
  AgentSessionSnapshotDTO,
  AgentSessionsPageDTO,
  AgentToolSummaryDTO,
  AgentTransportFrame,
  AgentTurnDTO,
  CreateAgentSessionRequest,
  ResolveAgentApprovalRequest,
} from '@musecanvas/contracts'
import type { SessionDto } from '@/shared/types'
import { clientApi } from '@/shared/services/client-api'
import { isApiError } from '@/shared/services/api'
import { subscribeAgentEvents } from '@/shared/services/agent-events'
import { mockAgentApi } from '@/shared/services/mock-agent-api'
import {
  agentConsoleScopeChanged,
  applyAgentEvent,
  applyAgentSnapshot,
  applyAgentTransportFrame,
  createEmptyAgentConsoleState,
  isTurnActive,
  prependOlderAgentItems,
  type AgentConsoleTimelineState,
} from '@/shared/lib/agent-console-state'
import { WORKSPACE_MODE, type WorkspaceMode } from '@/shared/lib/workspace-mode'
import { queryKeys } from './query-keys'

export type AgentServiceStatus = 'ready' | 'disabled_404' | 'admission_closed_503' | 'error'
export type AgentConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'resyncing' | 'error'

export interface UseAgentConsoleOptions {
  mode?: WorkspaceMode
}

export interface CreateAgentSessionInput {
  clientRequestId?: string
  agentDefinitionId: string
  definitionVersion: number
  defaultCanvasId?: string
}

export interface SendAgentMessageInput {
  sessionId?: string
  content: string
  clientMessageId?: string
}

export interface SteerAgentTurnInput {
  turnId: string
  content: string
  clientMessageId?: string
}

export interface ResolveAgentApprovalInput extends ResolveAgentApprovalRequest {
  approvalId: string
}

interface ConsoleScopeState {
  actorId: string
  sessionId: string | null
  generation: number
}

const SESSION_PAGE_SIZE = 30
const SNAPSHOT_ITEMS_LIMIT = 50
const MOCK_POLL_INTERVAL_MS = 250
const MAX_SSE_RETRIES = 6
const MAX_SSE_RESYNCS = 3

function createRequestUuid(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.()
  if (randomUuid) return randomUuid
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function shouldRetryAgentQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false
  if (isApiError(error)) {
    if ([400, 401, 403, 404, 409, 429, 503].includes(error.status)) return false
  }
  return true
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isAdmissionClosedError(error: unknown): boolean {
  return isApiError(error) && (error.status === 503 || error.code === 'UNAVAILABLE')
}

function isDisabled404Error(error: unknown): boolean {
  return isApiError(error) && error.status === 404
}

export interface AgentConsoleController {
  mode: WorkspaceMode
  actorId: string
  sessionId: string | null
  sessions: AgentSessionDTO[]
  sessionsQuery: UseInfiniteQueryResult<InfiniteData<AgentSessionsPageDTO, string | undefined>, Error>
  hasMoreSessions: boolean
  loadMoreSessions: () => void
  snapshotQuery: UseQueryResult<AgentSessionSnapshotDTO, Error>
  timeline: AgentConsoleTimelineState
  session: AgentSessionDTO | null
  activeTurn: AgentTurnDTO | null
  turnActive: boolean
  items: AgentItemDTO[]
  tools: AgentToolSummaryDTO[]
  approvals: AgentApprovalSummaryDTO[]
  pendingApprovals: AgentApprovalSummaryDTO[]
  serviceStatus: AgentServiceStatus
  connectionState: AgentConnectionState
  error: Error | null
  hasOlderItems: boolean
  loadingOlderItems: boolean
  loadOlderError: Error | null
  loadOlderItems: () => Promise<void>
  reconnect: () => void
  resync: () => Promise<void>
  createSession: (input: CreateAgentSessionInput) => Promise<AgentSessionDTO>
  sendMessage: (input: SendAgentMessageInput) => Promise<AgentMessageAcceptedDTO>
  steerTurn: (input: SteerAgentTurnInput) => Promise<AgentMessageAcceptedDTO>
  cancelTurn: (turnId?: string) => Promise<AgentTurnDTO>
  resolveApproval: (input: ResolveAgentApprovalInput) => Promise<AgentApprovalSummaryDTO>
  mutations: {
    createSession: UseMutationResult<
      AgentSessionDTO,
      Error,
      { payload: CreateAgentSessionRequest; scope: ConsoleScopeState }
    >
    sendMessage: UseMutationResult<
      AgentMessageAcceptedDTO,
      Error,
      { targetSessionId: string; payload: { clientMessageId: string; content: string }; scope: ConsoleScopeState }
    >
    steerTurn: UseMutationResult<
      AgentMessageAcceptedDTO,
      Error,
      { turnId: string; payload: { clientMessageId: string; content: string }; scope: ConsoleScopeState }
    >
    cancelTurn: UseMutationResult<AgentTurnDTO, Error, { turnId: string; scope: ConsoleScopeState }>
    resolveApproval: UseMutationResult<
      AgentApprovalSummaryDTO,
      Error,
      { approvalId: string; payload: ResolveAgentApprovalRequest; scope: ConsoleScopeState }
    >
  }
}

function resolveInitialTimeline(
  queryClient: ReturnType<typeof useQueryClient>,
  canQuery: boolean,
  actorId: string,
  sessionId: string | null,
): AgentConsoleTimelineState {
  const empty = createEmptyAgentConsoleState()
  if (!canQuery || !sessionId) return empty
  const cached = queryClient.getQueryData<AgentSessionSnapshotDTO>(
    queryKeys.agent.snapshot(actorId, sessionId),
  )
  if (!cached || cached.session.id !== sessionId) return empty
  return applyAgentSnapshot(empty, cached)
}

/**
 * 拥有当前选定 Agent 会话的生命周期。
 * 切换会话 / 用户或卸载组件时中止 SSE，绝不将 A 会话的事件或回调写入 B 会话，也绝不触发 `cancelTurn`。
 */
export function useAgentConsole(
  sessionId: string | null,
  options: UseAgentConsoleOptions = {},
): AgentConsoleController {
  const mode = options.mode ?? WORKSPACE_MODE
  const queryClient = useQueryClient()

  // 与 useSession 共享同一 queryKey，但 mock 模式下不发起 `/api/session` 请求。
  const liveSessionQuery = useQuery<SessionDto | null>({
    queryKey: queryKeys.session,
    queryFn: async () => {
      try {
        return await clientApi.session.get()
      } catch (error) {
        if (isApiError(error) && (error.status === 401 || error.code === 'UNAUTHORIZED')) return null
        throw error
      }
    },
    enabled: mode === 'live',
    staleTime: 60_000,
    retry: (failureCount, error) =>
      isApiError(error) && error.status === 401 ? false : failureCount < 2,
    refetchOnWindowFocus: true,
  })

  const actorId = mode === 'mock' ? 'mock-preview' : (liveSessionQuery.data?.user.id ?? '')
  const canQuery = mode === 'mock' || actorId !== ''

  const [timeline, setTimeline] = useState<AgentConsoleTimelineState>(() =>
    resolveInitialTimeline(queryClient, canQuery, actorId, sessionId),
  )
  const timelineRef = useRef(timeline)
  const [connectionState, setConnectionState] = useState<AgentConnectionState>(() =>
    sessionId ? 'connecting' : 'idle',
  )
  const [sseError, setSseError] = useState<Error | null>(null)
  const [admissionError, setAdmissionError] = useState<Error | null>(null)
  const [loadOlderError, setLoadOlderError] = useState<Error | null>(null)
  const [loadingOlderItems, setLoadingOlderItems] = useState(false)
  const loadingOlderRef = useRef(false)
  const [reconnectTick, setReconnectTick] = useState(0)
  const appliedSnapshotVersionRef = useRef<string>('')

  const latestRef = useRef<ConsoleScopeState>({ actorId, sessionId, generation: 0 })
  const renderedScopeRef = useRef({ actorId, sessionId })
  // 同步递增代次：隔离 A -> B -> A 快速切换后的在途异步回调。
  if (agentConsoleScopeChanged(renderedScopeRef.current, { actorId, sessionId })) {
    renderedScopeRef.current = { actorId, sessionId }
    latestRef.current = { actorId, sessionId, generation: latestRef.current.generation + 1 }
  }

  const isCurrentScope = useCallback((scope: ConsoleScopeState) => {
    const current = latestRef.current
    return (
      scope.actorId === current.actorId &&
      scope.sessionId === current.sessionId &&
      scope.generation === current.generation
    )
  }, [])

  const updateTimeline = useCallback(
    (reducer: (previous: AgentConsoleTimelineState) => AgentConsoleTimelineState) => {
      const next = reducer(timelineRef.current)
      timelineRef.current = next
      setTimeline(next)
      return next
    },
    [],
  )

  const sessionsQuery = useInfiniteQuery<
    AgentSessionsPageDTO,
    Error,
    InfiniteData<AgentSessionsPageDTO, string | undefined>,
    readonly unknown[],
    string | undefined
  >({
    queryKey: queryKeys.agent.sessions(actorId),
    enabled: canQuery,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      clientApi.agent.listSessions({
        limit: SESSION_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: shouldRetryAgentQuery,
  })

  const snapshotQuery = useQuery<AgentSessionSnapshotDTO, Error>({
    queryKey: queryKeys.agent.snapshot(actorId, sessionId ?? ''),
    enabled: Boolean(canQuery && sessionId),
    queryFn: () => clientApi.agent.getSnapshot(sessionId as string, { limit: SNAPSHOT_ITEMS_LIMIT }),
    retry: shouldRetryAgentQuery,
  })

  const isServiceDisabled404 =
    isDisabled404Error(sessionsQuery.error) ||
    (!sessionsQuery.isSuccess && isDisabled404Error(snapshotQuery.error))

  // 派生服务端状态：区分功能关闭 (404)、准入关闭 (503) 与普通故障。
  const serviceStatus = useMemo<AgentServiceStatus>(() => {
    if (isServiceDisabled404 || (!sessionsQuery.isSuccess && isDisabled404Error(sseError))) {
      return 'disabled_404'
    }
    if (
      isAdmissionClosedError(sessionsQuery.error) ||
      isAdmissionClosedError(snapshotQuery.error) ||
      isAdmissionClosedError(sseError) ||
      isAdmissionClosedError(admissionError)
    ) {
      return 'admission_closed_503'
    }
    if (sessionsQuery.isError || snapshotQuery.isError || (connectionState === 'error' && sseError !== null)) {
      return 'error'
    }
    return 'ready'
  }, [
    isServiceDisabled404,
    sessionsQuery.error,
    sessionsQuery.isError,
    sessionsQuery.isSuccess,
    snapshotQuery.error,
    snapshotQuery.isError,
    sseError,
    admissionError,
    connectionState,
  ])

  // 切换会话或 actor 时恢复目标会话缓存快照（无缓存时回退为空时间线）并重置重连状态，绝不保留上一会话残影。
  const previousActorRef = useRef(actorId)
  useEffect(() => {
    const previousActor = previousActorRef.current
    if (previousActor !== actorId) {
      previousActorRef.current = actorId
      if (previousActor) {
        queryClient.removeQueries({ queryKey: queryKeys.agent.sessions(previousActor) })
        queryClient.removeQueries({ queryKey: [queryKeys.agent.root[0], 'snapshot', previousActor] })
        queryClient.removeQueries({ queryKey: [queryKeys.agent.root[0], 'items', previousActor] })
        queryClient.removeQueries({ queryKey: [queryKeys.agent.root[0], 'turn', previousActor] })
      }
      setAdmissionError(null)
    }

    appliedSnapshotVersionRef.current = ''
    loadingOlderRef.current = false
    setLoadingOlderItems(false)
    setLoadOlderError(null)
    setSseError(null)
    setConnectionState(sessionId && canQuery ? 'connecting' : 'idle')
    updateTimeline(() => resolveInitialTimeline(queryClient, canQuery, actorId, sessionId))
  }, [actorId, sessionId, canQuery, queryClient, updateTimeline])

  // 卸载时递增代次，确保任何尚未落地的异步回调不再触碰已失效上下文。
  useEffect(
    () => () => {
      latestRef.current = { ...latestRef.current, generation: latestRef.current.generation + 1 }
    },
    [],
  )

  // 快照返回时合并进时间线（按 dataUpdatedAt 去重，避免无关重渲染重复归并）。
  useEffect(() => {
    const snapshot = snapshotQuery.data
    if (!snapshot || !sessionId || snapshot.session.id !== sessionId) return
    const versionKey = `${snapshot.session.id}:${snapshotQuery.dataUpdatedAt}`
    if (appliedSnapshotVersionRef.current === versionKey) return
    appliedSnapshotVersionRef.current = versionKey
    updateTimeline((prev) => applyAgentSnapshot(prev, snapshot))
  }, [snapshotQuery.data, snapshotQuery.dataUpdatedAt, sessionId, updateTimeline])

  // 同步并刷新指定会话快照的内部辅助（用于 resync 与 mock 订阅）。
  const syncSnapshot = useCallback(
    async (scope: ConsoleScopeState) => {
      if (!scope.sessionId) return null
      const fresh = await clientApi.agent.getSnapshot(scope.sessionId, { limit: SNAPSHOT_ITEMS_LIMIT })
      if (!isCurrentScope(scope)) return null
      queryClient.setQueryData(queryKeys.agent.snapshot(scope.actorId, scope.sessionId), fresh)
      updateTimeline((prev) => applyAgentSnapshot(prev, fresh))
      return fresh
    },
    [isCurrentScope, queryClient, updateTimeline],
  )

  // Live 模式：有限 SSE 自动重连循环（25s EOF 无缝续接，网络断流指数退避，resync.required 拉快照重置）。
  const snapshotReady = Boolean(
    snapshotQuery.data && sessionId && snapshotQuery.data.session.id === sessionId,
  )

  useEffect(() => {
    if (mode !== 'live' || !canQuery || !sessionId || !snapshotReady) return
    if (isServiceDisabled404) return

    const scope = { ...latestRef.current }
    const targetSessionId = sessionId
    const ac = new AbortController()

    const handleTransport = (frame: AgentTransportFrame) => {
      if (ac.signal.aborted || !isCurrentScope(scope)) return
      if (frame.type === 'ready' || frame.type === 'heartbeat') {
        setConnectionState('connected')
        setSseError(null)
      } else if (frame.type === 'resync.required') {
        setConnectionState('resyncing')
      }
      updateTimeline((prev) => applyAgentTransportFrame(prev, frame))
    }

    const handleEvent = (event: AgentEventEnvelope) => {
      if (ac.signal.aborted || !isCurrentScope(scope)) return
      const nextState = updateTimeline((prev) => applyAgentEvent(prev, event))
      if (event.type === 'turn.updated' && !isTurnActive(event.payload.turn)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agent.sessions(scope.actorId) })
        if (nextState.items.some((item) => item.type === 'artifact_reference')) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.library.root })
        }
        if (nextState.session?.defaultCanvasId) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.canvases.detail(nextState.session.defaultCanvasId),
          })
        }
      }
    }

    async function runLoop() {
      let attempt = 0
      let rapidEofCount = 0
      let resyncCount = 0

      while (!ac.signal.aborted && isCurrentScope(scope)) {
        setConnectionState(attempt === 0 && resyncCount === 0 ? 'connecting' : 'reconnecting')
        const openedAt = Date.now()
        const cursor = timelineRef.current.eventCursor

        try {
          const result = await subscribeAgentEvents({
            sessionId: targetSessionId,
            cursor,
            signal: ac.signal,
            onTransport: handleTransport,
            onEvent: handleEvent,
          })

          if (ac.signal.aborted || !isCurrentScope(scope)) break
          if (result.outcome === 'aborted') break

          if (result.outcome === 'resync_required') {
            resyncCount += 1
            if (resyncCount > MAX_SSE_RESYNCS) {
              setSseError(new Error('事件流需要频繁重同步，请刷新会话重试。'))
              setConnectionState('error')
              break
            }
            setConnectionState('resyncing')
            await syncSnapshot(scope)
            if (ac.signal.aborted || !isCurrentScope(scope)) break
            attempt = 0
            continue
          }

          // 服务端 ~25s 正常有限关闭（EOF）：无报错立即续连。
          attempt = 0
          resyncCount = 0
          const elapsed = Date.now() - openedAt
          if (elapsed < 250) {
            rapidEofCount += 1
            const guardDelay = Math.min(500 * Math.pow(2, rapidEofCount - 1), 5_000)
            await sleepWithSignal(guardDelay, ac.signal)
          } else {
            rapidEofCount = 0
            await sleepWithSignal(40, ac.signal)
          }
        } catch (err) {
          if (ac.signal.aborted || !isCurrentScope(scope)) break

          if (isApiError(err)) {
            if (err.status === 404 || err.status === 401 || err.status === 403) {
              setSseError(err)
              setConnectionState('error')
              break
            }
            if (err.status === 409) {
              if (resyncCount < 2) {
                resyncCount += 1
                setConnectionState('resyncing')
                try {
                  await syncSnapshot(scope)
                  attempt = 0
                  continue
                } catch (syncErr) {
                  setSseError(syncErr instanceof Error ? syncErr : err)
                  setConnectionState('error')
                  break
                }
              }
              setSseError(err)
              setConnectionState('error')
              break
            }
            if (err.status === 503) {
              setSseError(err)
            }
          }

          attempt += 1
          if (attempt > MAX_SSE_RETRIES) {
            setSseError(err instanceof Error ? err : new Error('事件流连接已断开，请重试。'))
            setConnectionState('error')
            break
          }

          setConnectionState('reconnecting')
          const backoffMs = Math.min(500 * Math.pow(2, attempt - 1), 15_000)
          await sleepWithSignal(backoffMs, ac.signal)
        }
      }
    }

    void runLoop()

    return () => {
      // 仅中止 GET /events SSE 流，绝不调用 cancelTurn。
      ac.abort()
    }
  }, [mode, canQuery, sessionId, snapshotReady, isServiceDisabled404, reconnectTick, isCurrentScope, queryClient, syncSnapshot, updateTimeline])

  // Mock 模式：订阅本地模拟引擎事件并仅在轮次处于时间推进期时运行轻量轮询。
  const turnPhaseActive = Boolean(
    timeline.activeTurn &&
      (timeline.activeTurn.status === 'queued' ||
        timeline.activeTurn.status === 'running' ||
        timeline.activeTurn.status === 'waiting_tools'),
  )

  useEffect(() => {
    if (mode !== 'mock' || !sessionId) return
    const scope = { ...latestRef.current }
    setConnectionState('connected')

    const refresh = () => {
      if (!isCurrentScope(scope)) return
      void syncSnapshot(scope)
        .then((fresh) => {
          if (!fresh || !isCurrentScope(scope)) return
          if (!isTurnActive(fresh.activeTurn)) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.agent.sessions(scope.actorId) })
          }
        })
        .catch(() => {
          // Mock 引擎状态在本地内存中维护，忽略瞬时竞态异常。
        })
    }

    const unsubscribe = mockAgentApi.subscribe(sessionId, refresh)
    const timer = turnPhaseActive ? setInterval(refresh, MOCK_POLL_INTERVAL_MS) : undefined

    return () => {
      unsubscribe()
      if (timer) clearInterval(timer)
    }
  }, [mode, sessionId, turnPhaseActive, isCurrentScope, queryClient, syncSnapshot])

  const loadOlderItems = useCallback(async () => {
    const scope = { ...latestRef.current }
    const targetSessionId = scope.sessionId
    if (!targetSessionId || !timelineRef.current.itemsHasMore || loadingOlderRef.current) return
    loadingOlderRef.current = true
    setLoadingOlderItems(true)
    setLoadOlderError(null)
    try {
      const page = await clientApi.agent.listItems(targetSessionId, {
        cursor: timelineRef.current.nextItemsCursor,
        limit: SNAPSHOT_ITEMS_LIMIT,
      })
      if (!isCurrentScope(scope)) return
      updateTimeline((prev) => prependOlderAgentItems(prev, page))
    } catch (err) {
      if (isCurrentScope(scope)) {
        setLoadOlderError(err instanceof Error ? err : new Error('加载后续记录失败，请稍后重试。'))
      }
    } finally {
      loadingOlderRef.current = false
      if (isCurrentScope(scope)) setLoadingOlderItems(false)
    }
  }, [isCurrentScope, updateTimeline])

  const reconnect = useCallback(() => {
    const scope = latestRef.current
    setSseError(null)
    setAdmissionError(null)
    setLoadOlderError(null)
    if (scope.actorId) {
      void queryClient.refetchQueries({ queryKey: queryKeys.agent.sessions(scope.actorId) })
      if (scope.sessionId) {
        void queryClient.refetchQueries({
          queryKey: queryKeys.agent.snapshot(scope.actorId, scope.sessionId),
        })
      }
    }
    setReconnectTick((n) => n + 1)
  }, [queryClient])

  const resync = useCallback(async () => {
    const scope = { ...latestRef.current }
    if (!scope.sessionId) return
    setConnectionState('resyncing')
    try {
      await syncSnapshot(scope)
      if (isCurrentScope(scope)) {
        setSseError(null)
        setAdmissionError(null)
        setConnectionState(mode === 'mock' ? 'connected' : 'connecting')
        setReconnectTick((n) => n + 1)
      }
    } catch (err) {
      if (isCurrentScope(scope)) {
        setSseError(err instanceof Error ? err : new Error('刷新会话快照失败，请稍后重试。'))
        setConnectionState('error')
      }
    }
  }, [isCurrentScope, mode, syncSnapshot])

  // ---------------------------------------------------------------------------
  // 变更动作（Mutations）
  // ---------------------------------------------------------------------------

  const createSessionMutation = useMutation<
    AgentSessionDTO,
    Error,
    { payload: CreateAgentSessionRequest; scope: ConsoleScopeState }
  >({
    mutationFn: ({ payload }) => clientApi.agent.createSession(payload),
    onSuccess: (created, { scope }) => {
      setAdmissionError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.agent.sessions(scope.actorId) })
      if (scope.actorId) {
        queryClient.setQueryData(queryKeys.agent.snapshot(scope.actorId, created.id), {
          session: created,
          activeTurn: null,
          items: [],
          eventCursor: '0',
          lastItemSequence: '0',
          itemsHasMore: false,
          nextItemsCursor: '0',
          tools: [],
          approvals: [],
          summariesTruncated: false,
        } satisfies AgentSessionSnapshotDTO)
      }
    },
    onError: (err) => {
      if (isAdmissionClosedError(err)) setAdmissionError(err)
    },
  })

  const sendMessageMutation = useMutation<
    AgentMessageAcceptedDTO,
    Error,
    { targetSessionId: string; payload: { clientMessageId: string; content: string }; scope: ConsoleScopeState }
  >({
    mutationFn: ({ targetSessionId, payload }) => clientApi.agent.sendMessage(targetSessionId, payload),
    onSuccess: (accepted, { targetSessionId, scope }) => {
      setAdmissionError(null)
      void queryClient.invalidateQueries({ queryKey: queryKeys.agent.sessions(scope.actorId) })
      if (!isCurrentScope(scope) || targetSessionId !== scope.sessionId) return
      updateTimeline((prev) => {
        if (prev.session && prev.session.id !== targetSessionId) return prev
        const nextSession = prev.session
          ? {
              ...prev.session,
              activeTurnId: accepted.turn.id,
              inputRevision: accepted.acceptedInputRevision,
            }
          : prev.session
        const shouldAcceptTurn =
          !prev.activeTurn ||
          prev.activeTurn.id !== accepted.turn.id ||
          BigInt(accepted.turn.revision) >= BigInt(prev.activeTurn.revision)
        return {
          ...prev,
          session: nextSession,
          activeTurn: shouldAcceptTurn ? accepted.turn : prev.activeTurn,
        }
      })
      if (mode === 'mock') void syncSnapshot(scope)
    },
    onError: (err) => {
      if (isAdmissionClosedError(err)) setAdmissionError(err)
    },
  })

  const steerTurnMutation = useMutation<
    AgentMessageAcceptedDTO,
    Error,
    { turnId: string; payload: { clientMessageId: string; content: string }; scope: ConsoleScopeState }
  >({
    mutationFn: ({ turnId, payload }) => clientApi.agent.steerTurn(turnId, payload),
    onSuccess: (accepted, { scope }) => {
      if (!isCurrentScope(scope)) return
      updateTimeline((prev) => {
        const shouldAccept =
          !prev.activeTurn ||
          prev.activeTurn.id !== accepted.turn.id ||
          BigInt(accepted.turn.revision) >= BigInt(prev.activeTurn.revision)
        return shouldAccept ? { ...prev, activeTurn: accepted.turn } : prev
      })
      if (mode === 'mock') void syncSnapshot(scope)
    },
  })

  const cancelTurnMutation = useMutation<
    AgentTurnDTO,
    Error,
    { turnId: string; scope: ConsoleScopeState }
  >({
    mutationFn: ({ turnId }) => clientApi.agent.cancelTurn(turnId),
    onSuccess: (turn, { scope }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agent.sessions(scope.actorId) })
      if (!isCurrentScope(scope)) return
      updateTimeline((prev) => {
        const shouldAccept =
          !prev.activeTurn ||
          prev.activeTurn.id !== turn.id ||
          BigInt(turn.revision) >= BigInt(prev.activeTurn.revision)
        return {
          ...prev,
          activeTurn: shouldAccept ? turn : prev.activeTurn,
        }
      })
      if (mode === 'mock') void syncSnapshot(scope)
    },
  })

  const resolveApprovalMutation = useMutation<
    AgentApprovalSummaryDTO,
    Error,
    { approvalId: string; payload: ResolveAgentApprovalRequest; scope: ConsoleScopeState }
  >({
    mutationFn: ({ approvalId, payload }) => clientApi.agent.resolveApproval(approvalId, payload),
    onSuccess: (approval, { scope }) => {
      if (!isCurrentScope(scope)) return
      updateTimeline((prev) => {
        const existing = prev.approvals[approval.id]
        if (existing && BigInt(approval.revision) < BigInt(existing.revision)) return prev
        return {
          ...prev,
          approvals: { ...prev.approvals, [approval.id]: approval },
        }
      })
      if (mode === 'mock') void syncSnapshot(scope)
    },
    onError: (err, { scope }) => {
      if (isApiError(err) && (err.status === 409 || err.code === 'APPROVAL_EXPIRED') && isCurrentScope(scope)) {
        void syncSnapshot(scope)
      }
    },
  })

  const createSession = useCallback(
    (input: CreateAgentSessionInput) => {
      const scope = { ...latestRef.current }
      return createSessionMutation.mutateAsync({
        scope,
        payload: {
          clientRequestId: input.clientRequestId ?? createRequestUuid(),
          agentDefinitionId: input.agentDefinitionId,
          definitionVersion: input.definitionVersion,
          ...(input.defaultCanvasId ? { defaultCanvasId: input.defaultCanvasId } : {}),
        },
      })
    },
    [createSessionMutation],
  )

  const sendMessage = useCallback(
    (input: SendAgentMessageInput) => {
      const scope = { ...latestRef.current }
      const targetSessionId = input.sessionId ?? scope.sessionId
      if (!targetSessionId) return Promise.reject(new Error('请先选择或创建 Agent 会话。'))
      return sendMessageMutation.mutateAsync({
        targetSessionId,
        scope,
        payload: {
          clientMessageId: input.clientMessageId ?? createRequestUuid(),
          content: input.content,
        },
      })
    },
    [sendMessageMutation],
  )

  const steerTurn = useCallback(
    (input: SteerAgentTurnInput) => {
      const scope = { ...latestRef.current }
      return steerTurnMutation.mutateAsync({
        turnId: input.turnId,
        scope,
        payload: {
          clientMessageId: input.clientMessageId ?? createRequestUuid(),
          content: input.content,
        },
      })
    },
    [steerTurnMutation],
  )

  const cancelTurn = useCallback(
    (turnId?: string) => {
      const scope = { ...latestRef.current }
      const targetTurnId = turnId ?? timelineRef.current.activeTurn?.id
      if (!targetTurnId) return Promise.reject(new Error('当前没有进行中的轮次。'))
      return cancelTurnMutation.mutateAsync({ turnId: targetTurnId, scope })
    },
    [cancelTurnMutation],
  )

  const resolveApproval = useCallback(
    (input: ResolveAgentApprovalInput) => {
      const scope = { ...latestRef.current }
      return resolveApprovalMutation.mutateAsync({
        approvalId: input.approvalId,
        scope,
        payload: {
          decision: input.decision,
          expectedArgumentsHash: input.expectedArgumentsHash,
        },
      })
    },
    [resolveApprovalMutation],
  )

  const sessions = useMemo(
    () => sessionsQuery.data?.pages.flatMap((page) => page.sessions) ?? [],
    [sessionsQuery.data],
  )
  const tools = useMemo(() => Object.values(timeline.tools), [timeline.tools])
  const approvals = useMemo(() => Object.values(timeline.approvals), [timeline.approvals])
  const pendingApprovals = useMemo(
    () => approvals.filter((approval) => approval.status === 'pending'),
    [approvals],
  )

  const error =
    sessionsQuery.error ??
    snapshotQuery.error ??
    sseError ??
    admissionError ??
    null

  return {
    mode,
    actorId,
    sessionId,
    sessions,
    sessionsQuery,
    hasMoreSessions: Boolean(sessionsQuery.hasNextPage),
    loadMoreSessions: () => {
      if (sessionsQuery.hasNextPage && !sessionsQuery.isFetchingNextPage) {
        void sessionsQuery.fetchNextPage()
      }
    },
    snapshotQuery,
    timeline,
    session: timeline.session,
    activeTurn: timeline.activeTurn,
    turnActive: isTurnActive(timeline.activeTurn),
    items: timeline.items,
    tools,
    approvals,
    pendingApprovals,
    serviceStatus,
    connectionState,
    error,
    hasOlderItems: timeline.itemsHasMore,
    loadingOlderItems,
    loadOlderError,
    loadOlderItems,
    reconnect,
    resync,
    createSession,
    sendMessage,
    steerTurn,
    cancelTurn,
    resolveApproval,
    mutations: {
      createSession: createSessionMutation,
      sendMessage: sendMessageMutation,
      steerTurn: steerTurnMutation,
      cancelTurn: cancelTurnMutation,
      resolveApproval: resolveApprovalMutation,
    },
  }
}
