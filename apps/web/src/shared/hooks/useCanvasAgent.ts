'use client'

// Canvas Agent 对话控制器：状态 + history 读取、POST-SSE 发送、提案确认、
// agent-managed 画布 apply 与断线恢复。UI 只消费本 hook，不自行拼协议。
//
// 关键事实（读 apps/api/src/modules/canvases/agent/**）：
// - `POST canvases/:id/agent/messages` 返回 `text/event-stream`，终态为 done/error；
// - 提案必须经 `POST .../confirm` 才会创建 generation job；
// - 画布改动在确认落定后由 `POST .../apply` 提交（revision CAS）；
// - `GET .../turns/:turnId` 是恢复/轮询用的 durable 状态，不替代 SSE。

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type {
  CanvasAgentHistoryDto,
  CanvasAgentStatusDto,
  CanvasAgentTurnRecoveryDto,
} from '@musecanvas/contracts'
import { clientApi, LATEST_HISTORY_SEQ } from '@/shared/services/client-api'
import {
  AgentStreamDisconnectedError,
  AgentStreamHttpError,
  createAgentSubmitLock,
  streamAgentEvents,
} from '@/shared/lib/agent-stream'
import {
  createComposerSender,
  type ComposerDraft,
  type ComposerSender,
} from '@/shared/lib/agent-composer'
import {
  agentScopeChanged,
  appendUserMessage,
  applyAgentTimelineEvent,
  applyFailureMessage,
  applyPendingSnapshot,
  beginConfirmation,
  confirmationFailed,
  confirmationFor,
  confirmationSucceeded,
  createAgentTimeline,
  createConfirmationState,
  describeApplyResult,
  mergeHistoryPage,
  planApplyRecovery,
  resolveAgentAvailability,
  shouldApplyTurn,
  unappliedOpsTurnIds,
  type AgentTimelineState,
  type ApplyFeedback,
  type ConfirmationMap,
} from '@/shared/lib/agent-timeline'
import { CANVAS_AGENT_POLL_MS, queryKeys } from './query-keys'
import { useSession } from './useSession'

export type { AgentStreamEvent } from '@musecanvas/contracts'

interface AgentRequestScope {
  actorId: string
  canvasId: string | null
  generation: number
}

/** Agent 是否可发起新 turn（只读状态，不调用供应商）。 */
export function useCanvasAgentStatus(): UseQueryResult<CanvasAgentStatusDto> {
  const session = useSession()
  return useQuery({
    queryKey: queryKeys.canvasAgent.status,
    queryFn: () => clientApi.canvasAgent.getStatus(),
    enabled: Boolean(session.data),
    staleTime: 60_000,
  })
}

/** durable turn 状态轮询：仅在 SSE 断线/刷新恢复时使用，终态自动停止。 */
export function useCanvasAgentTurn(
  canvasId: string | null | undefined,
  turnId: string | null | undefined,
): UseQueryResult<CanvasAgentTurnRecoveryDto> {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.canvasAgent.turn(canvasId ?? '', turnId ?? ''),
    queryFn: () => clientApi.canvasAgent.getTurn(canvasId as string, turnId as string),
    enabled: Boolean(canvasId && turnId),
    refetchInterval: (q) => {
      const status = q.state.data?.status
      return status === 'running' ? CANVAS_AGENT_POLL_MS : false
    },
  })
  const status = query.data?.status
  useEffect(() => {
    if (!canvasId || !status || status === 'running') return
    // turn 已终态：把持久 history 重新读回来（断线期间的消息/提案由此补齐）。
    void queryClient.invalidateQueries({ queryKey: queryKeys.canvasAgent.history(canvasId) })
  }, [canvasId, status, queryClient])
  return query
}

/** 会话历史（倒序分页，首屏取最新一页）。 */
export function useCanvasAgentHistory(
  canvasId: string | null,
): UseInfiniteQueryResult<{ pages: CanvasAgentHistoryDto[]; pageParams: number[] }, Error> {
  const session = useSession()
  return useInfiniteQuery({
    queryKey: queryKeys.canvasAgent.history(canvasId ?? ''),
    enabled: Boolean(session.data && canvasId),
    initialPageParam: LATEST_HISTORY_SEQ,
    queryFn: ({ pageParam }) =>
      clientApi.canvasAgent.getHistory(canvasId as string, { beforeSeq: pageParam, limit: 50 }),
    getNextPageParam: (page: CanvasAgentHistoryDto) => page.nextBeforeSeq ?? undefined,
  }) as UseInfiniteQueryResult<{ pages: CanvasAgentHistoryDto[]; pageParams: number[] }, Error>
}

export interface CanvasAgentController {
  canvasId: string | null
  items: AgentTimelineState['items']
  streaming: boolean
  streamError: string | null
  disconnected: boolean
  availability: ReturnType<typeof resolveAgentAvailability>
  status: UseQueryResult<CanvasAgentStatusDto>
  confirmations: ConfirmationMap
  applyFeedback: ApplyFeedback | null
  /** 发送一次结构化 user turn；锁被占用/文本为空返回 false。 */
  send: (draft: ComposerDraft, baseRevision: number, targetCanvasId?: string) => boolean
  /** 显式「继续规划」：任务终态后的 job_event turn。 */
  continuePlanning: (jobId: string, baseRevision: number) => boolean
  stop: () => void
  confirmPending: (pendingId: string, approve: boolean) => void
  confirmationFor: (pendingId: string) => ReturnType<typeof confirmationFor>
  /** 直接 apply 某 turn 的 ops（恢复路径/手动重试）。 */
  applyTurn: (turnId: string) => void
  history: {
    query: ReturnType<typeof useCanvasAgentHistory>
    loading: boolean
    hasOlder: boolean
    loadOlder: () => void
  }
}

/**
 * 拥有当前对话的 Agent 控制器。切换对话或登录用户变化时中止流，
 * 并清空时间线/确认状态，绝不把上一段对话的帧写进新的对话。
 */
export function useCanvasAgent(canvasId: string | null): CanvasAgentController {
  const queryClient = useQueryClient()
  const session = useSession()
  const actorId = session.data?.user.id ?? ''
  const statusQuery = useCanvasAgentStatus()
  const historyQuery = useCanvasAgentHistory(canvasId)

  const [timeline, setTimeline] = useState<AgentTimelineState>(createAgentTimeline)
  const timelineRef = useRef(timeline)
  const [streaming, setStreaming] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [disconnected, setDisconnected] = useState(false)
  const [confirmations, setConfirmations] = useState<ConfirmationMap>(createConfirmationState)
  const confirmationsRef = useRef(confirmations)
  confirmationsRef.current = confirmations
  const [applyFeedback, setApplyFeedback] = useState<ApplyFeedback | null>(null)

  const latestRef = useRef<AgentRequestScope>({ actorId, canvasId, generation: 0 })
  const renderedScopeRef = useRef({ actorId, canvasId })
  // 同步失效旧请求；代次也隔离 A → B → A，不能只比较最终的用户/画布 id。
  if (renderedScopeRef.current.actorId !== actorId || renderedScopeRef.current.canvasId !== canvasId) {
    renderedScopeRef.current = { actorId, canvasId }
    latestRef.current = { actorId, canvasId, generation: latestRef.current.generation + 1 }
  }
  const isCurrentScope = useCallback((scope: AgentRequestScope) => {
    const current = latestRef.current
    return scope.actorId === current.actorId && scope.canvasId === current.canvasId &&
      scope.generation === current.generation
  }, [])

  /** 同步写时间线，保证异步回调读到的就是 setter 刚产出的状态。 */
  const updateTimeline = useCallback(
    (reducer: (previous: AgentTimelineState) => AgentTimelineState) => {
      const next = reducer(timelineRef.current)
      timelineRef.current = next
      setTimeline(next)
    },
    [],
  )

  const invalidateConversation = useCallback((scope = latestRef.current) => {
    const { actorId: actor, canvasId: canvas } = scope
    if (!actor || !canvas) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.canvasAgent.history(canvas) })
  }, [queryClient])

  const applyInFlightRef = useRef(new Set<string>())
  const applyMutation = useMutation({
    mutationFn: (input: { turnId: string; scope: AgentRequestScope; key: string }) => {
      const canvas = input.scope.canvasId
      if (!canvas) throw new Error('缺少对话')
      return clientApi.canvasAgent.apply(canvas, input.turnId)
    },
    onSuccess: (result, input) => {
      if (isCurrentScope(input.scope)) setApplyFeedback(describeApplyResult(result))
      const { actorId: actor, canvasId: canvas } = input.scope
      if (actor && canvas) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.canvasAgent.history(canvas) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.canvases.detail(canvas) })
      }
      // apply 会提交 scene，可能写实 asset 关联：刷新任务/图库缓存。
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.root })
      void queryClient.invalidateQueries({ queryKey: queryKeys.library.root })
    },
    onError: (error, input) => {
      if (!isCurrentScope(input.scope)) return
      setApplyFeedback({ applied: false, revision: 0, opCount: 0, message: applyFailureMessage(error) })
    },
    onSettled: (_result, _error, input) => {
      applyInFlightRef.current.delete(input.key)
    },
  })
  const applyRef = useRef(applyMutation)
  applyRef.current = applyMutation

  // 自动恢复逐 turn 仅尝试一次；手动重试绕过去重，但仍受跨会话的在途锁保护。
  const applyAttemptedRef = useRef<Set<string>>(new Set())
  const applyRecoveryNewestRef = useRef<string | null>(null)
  const dispatchActorRef = useRef('')

  const requestApply = useCallback((turnId: string | null | undefined, manual = false) => {
    if (!turnId) return
    const scope = { ...latestRef.current }
    if (!scope.actorId || !scope.canvasId) return
    const key = JSON.stringify([scope.actorId, scope.canvasId, turnId])
    if (applyInFlightRef.current.has(key)) return
    if (!manual && applyAttemptedRef.current.has(turnId)) return
    applyAttemptedRef.current.add(turnId)
    applyInFlightRef.current.add(key)
    applyRef.current.mutate({ turnId, scope, key })
  }, [])

  const confirmMutation = useMutation({
    mutationFn: (input: { pendingId: string; approve: boolean; scope: AgentRequestScope }) => {
      const canvas = input.scope.canvasId
      if (!canvas) throw new Error('缺少对话')
      return clientApi.canvasAgent.confirm(canvas, input.pendingId, input.approve)
    },
    onSuccess: (result, input) => {
      invalidateConversation(input.scope)
      // 已提交的提案会生成 job 行：刷新任务列表，让结果卡从同一数据源解析。
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.root })
      if (!isCurrentScope(input.scope)) return
      updateTimeline((previous) => applyPendingSnapshot(previous, result.pending))
      setConfirmations((map) => confirmationSucceeded(map, result))
      const turnId = result.pending.turnId
      if (turnId && shouldApplyTurn(timelineRef.current, turnId)) requestApply(turnId)
    },
    onError: (error, input) => {
      invalidateConversation(input.scope)
      if (!isCurrentScope(input.scope)) return
      setConfirmations((map) => confirmationFailed(map, input.pendingId, error))
    },
  })

  // 唯一的发送路径；创建一次，回调从 ref 读实时 canvas/actor，避免陈旧闭包。
  const senderRef = useRef<ComposerSender | null>(null)
  if (!senderRef.current) {
    senderRef.current = createComposerSender(
      {
        stream: (targetCanvasId, request, signal) =>
          streamAgentEvents(API_ENDPOINTS.canvases.agent.messages(targetCanvasId), request, { signal }),
        onRequest: (request, canvas) => {
          if (canvas !== latestRef.current.canvasId) return
          if (dispatchActorRef.current !== latestRef.current.actorId) return
          setStreaming(true)
          setStreamError(null)
          setDisconnected(false)
          if (request.kind === 'user') {
            updateTimeline((previous) =>
              appendUserMessage(previous, {
                id: request.messageId,
                text: request.text,
                contextSummary: request.context,
                createdAt: new Date().toISOString(),
              }),
            )
          }
        },
        onEvent: (event, canvas) => {
          // 切换对话后仍在途的帧必须丢弃，尤其不能对新 canvas 触发 apply。
          if (canvas !== latestRef.current.canvasId) return
          if (dispatchActorRef.current !== latestRef.current.actorId) return
          updateTimeline((previous) => applyAgentTimelineEvent(previous, event))
          if (event.type === 'done' && shouldApplyTurn(timelineRef.current, event.turnId, event.message.ops?.length ?? 0)) {
            requestApply(event.turnId)
          }
        },
        onSettled: (outcome, canvas) => {
          if (canvas !== latestRef.current.canvasId) return
          if (dispatchActorRef.current !== latestRef.current.actorId) return
          setStreaming(false)
          if (outcome.status === 'error') {
            if (outcome.error instanceof AgentStreamHttpError) setStreamError(outcome.error.message)
            else if (outcome.error instanceof AgentStreamDisconnectedError) setDisconnected(true)
            else setStreamError(outcome.error instanceof Error ? outcome.error.message : 'Agent 请求失败')
          }
          // 任何终局都重新读持久事实：断线时服务端可能知道得更多。
          invalidateConversation()
        },
      },
      createAgentSubmitLock(),
    )
  }

  // 切换对话：中止在途流并清空上一段对话状态（null → id 的首建保留乐观消息）。
  const previousCanvasIdRef = useRef(canvasId)
  useEffect(() => {
    const previous = previousCanvasIdRef.current
    previousCanvasIdRef.current = canvasId
    if (previous === null || previous === canvasId) return
    senderRef.current?.stop()
    updateTimeline(() => createAgentTimeline())
    applyAttemptedRef.current = new Set()
    applyRecoveryNewestRef.current = null
    setApplyFeedback(null)
    setStreaming(false)
    setStreamError(null)
    setDisconnected(false)
    setConfirmations(createConfirmationState())
  }, [canvasId, updateTimeline])

  // 合并持久 history（幂等：重复拉取只更新不重复）。
  useEffect(() => {
    const pages = historyQuery.data?.pages
    if (!pages || pages.length === 0) return
    updateTimeline((previous) => {
      let next = previous
      // pages 最新在前：反向合并，让旧页按 seq 前插。
      for (const page of [...pages].reverse()) {
        next = mergeHistoryPage(next, page.messages, page.pendingJobs)
      }
      return next
    })
  }, [historyQuery.data, updateTimeline])

  // 断线/刷新后的一次有界 apply 恢复：只补最新 ops turn，且逐 turn 仅一次。
  useEffect(() => {
    if (streaming) return
    if (!historyQuery.data) return
    const opsTurns = unappliedOpsTurnIds(timelineRef.current)
    if (opsTurns.length === 0) return
    const newest = opsTurns[opsTurns.length - 1]!
    if (applyRecoveryNewestRef.current === newest) return
    applyRecoveryNewestRef.current = newest
    const turnId = planApplyRecovery(timelineRef.current, applyAttemptedRef.current)
    if (turnId) requestApply(turnId)
  }, [timeline, streaming, historyQuery.data, requestApply])

  // 登录用户变化：中止流、清空上一用户时间线与缓存。
  const actorRef = useRef(actorId)
  useEffect(() => {
    if (!agentScopeChanged(actorRef.current, actorId)) return
    const previous = actorRef.current
    actorRef.current = actorId
    senderRef.current?.stop()
    updateTimeline(() => createAgentTimeline())
    setStreaming(false)
    setStreamError(null)
    setDisconnected(false)
    setConfirmations(createConfirmationState())
    setApplyFeedback(null)
    applyAttemptedRef.current = new Set()
    applyRecoveryNewestRef.current = null
    if (previous) {
      queryClient.removeQueries({ queryKey: queryKeys.canvasAgent.history('') })
      queryClient.removeQueries({ queryKey: queryKeys.canvasAgent.status })
      queryClient.removeQueries({ queryKey: queryKeys.canvases.root })
    }
  }, [actorId, queryClient, updateTimeline])

  useEffect(
    () => () => {
      senderRef.current?.stop()
      latestRef.current = { ...latestRef.current, generation: latestRef.current.generation + 1 }
    },
    [],
  )

  const confirmPending = useCallback(
    (pendingId: string, approve: boolean) => {
      const scope = { ...latestRef.current }
      if (!scope.actorId || !scope.canvasId) return
      if (confirmationFor(confirmationsRef.current, pendingId).phase === 'submitting') return
      const next = beginConfirmation(confirmationsRef.current, pendingId, approve ? 'confirm' : 'reject')
      confirmationsRef.current = next
      setConfirmations(next)
      confirmMutation.mutate({ pendingId, approve, scope })
    },
    [confirmMutation],
  )

  /** 发送结构化草稿。返回 false 表示：空文本/锁被占用/缺对话。 */
  const send = useCallback((draft: ComposerDraft, baseRevision: number, targetCanvasId?: string) => {
    const canvas = targetCanvasId ?? latestRef.current.canvasId
    if (!canvas || !senderRef.current) return false
    latestRef.current = { ...latestRef.current, canvasId: canvas }
    dispatchActorRef.current = latestRef.current.actorId
    return senderRef.current.sendUserMessage({ canvasId: canvas, baseRevision, draft })
  }, [])

  const continuePlanning = useCallback((jobId: string, baseRevision: number) => {
    const canvas = latestRef.current.canvasId
    if (!canvas || !senderRef.current) return false
    dispatchActorRef.current = latestRef.current.actorId
    return senderRef.current.sendJobEvent({ canvasId: canvas, baseRevision, jobId })
  }, [])

  const stop = useCallback(() => {
    senderRef.current?.stop()
  }, [])

  const availability = resolveAgentAvailability(statusQuery.data)

  return {
    canvasId,
    items: timeline.items,
    streaming,
    streamError,
    disconnected,
    availability,
    status: statusQuery,
    confirmations,
    applyFeedback,
    send,
    continuePlanning,
    stop,
    confirmPending,
    confirmationFor: (pendingId: string) => confirmationFor(confirmationsRef.current, pendingId),
    applyTurn: (turnId: string) => requestApply(turnId, true),
    history: {
      query: historyQuery,
      loading: historyQuery.isLoading,
      hasOlder: Boolean(historyQuery.hasNextPage),
      loadOlder: () => void historyQuery.fetchNextPage(),
    },
  }
}
