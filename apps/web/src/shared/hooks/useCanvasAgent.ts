'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type {
  AgentMessageDto,
  AgentStreamEvent,
  CanvasAgentHistoryDto,
} from '@musecanvas/contracts'
import { canvasApi, LATEST_HISTORY_SEQ } from '@/features/generate/lib/canvas-api'
import {
  actorScopedCanvasQueryKeys,
  CANVAS_AGENT_STATUS_KEY,
  canvasAgentHistoryQueryKey,
} from '@/features/generate/lib/canvas-query-keys'
import {
  AgentStreamDisconnectedError,
  AgentStreamHttpError,
  createAgentSubmitLock,
  streamAgentEvents,
} from '@/features/generate/lib/agent-stream'
import { createComposerSender } from '@/features/generate/lib/agent-composer'
import type { ComposerDraft, ComposerSender } from '@/features/generate/lib/agent-composer'
import {
  beginConfirmation,
  confirmationFailed,
  confirmationFor,
  confirmationSucceeded,
  createConfirmationState,
} from '@/features/generate/lib/agent-confirmation'
import type { ConfirmationMap } from '@/features/generate/lib/agent-confirmation'
import {
  agentScopeChanged,
  appendUserMessage,
  applyAgentTimelineEvent,
  applyFailureMessage,
  applyPendingSnapshot,
  createAgentTimeline,
  describeApplyResult,
  mergeHistoryPage,
  planApplyRecovery,
  resolveAgentAvailability,
  shouldApplyTurn,
  unappliedOpsTurnIds,
} from '@/features/generate/lib/agent-turn-state'
import type { AgentTimelineState, ApplyFeedback } from '@/features/generate/lib/agent-turn-state'
import { useCurrentActorId } from './useCanvases'
import { JOBS_QUERY_KEY } from './useJobs'
import { LIBRARY_QUERY_KEY } from './useLibrary'

export { CANVAS_AGENT_STATUS_KEY, canvasAgentHistoryQueryKey, actorScopedCanvasQueryKeys } from '@/features/generate/lib/canvas-query-keys'

/** Whether the Agent can start a turn at all. Read-only; never calls a provider. */
export function useCanvasAgentStatusQuery() {
  const actorId = useCurrentActorId()
  return useQuery({
    queryKey: [...CANVAS_AGENT_STATUS_KEY, actorId],
    enabled: actorId !== '',
    queryFn: () => canvasApi.status(),
    refetchInterval: false,
  })
}

/**
 * Backward-paginated history. The first page is the newest 50 messages (fetched
 * with `beforeSeq = LATEST_HISTORY_SEQ`); `nextBeforeSeq` walks toward older pages.
 * Pages are kept newest-first by the query, and `historyMessages` re-orders them
 * oldest→newest for display.
 */
export function useCanvasAgentHistoryQuery(canvasId: string | null) {
  const actorId = useCurrentActorId()
  return useInfiniteQuery({
    queryKey: canvasAgentHistoryQueryKey(actorId, canvasId ?? ''),
    enabled: Boolean(actorId && canvasId),
    initialPageParam: LATEST_HISTORY_SEQ,
    queryFn: ({ pageParam }) => canvasApi.history(canvasId as string, { beforeSeq: pageParam, limit: 50 }),
    getNextPageParam: (page: CanvasAgentHistoryDto) => page.nextBeforeSeq ?? undefined,
  })
}

/**
 * Owns the Canvas Agent conversation: status + history queries, the streaming send
 * path, confirmation lifecycle and the managed-apply call.
 *
 * Nothing here auto-submits or auto-continues on its own: a turn starts only from an
 * explicit composer send or an explicitly authorised job_event continuation. The
 * stream is aborted — and the timeline, confirmations and apply feedback cleared —
 * on actor switch, logout (actor becomes empty) and unmount.
 */
export function useCanvasAgent(canvasId: string | null) {
  const actorId = useCurrentActorId()
  const queryClient = useQueryClient()
  const statusQuery = useCanvasAgentStatusQuery()
  const historyQuery = useCanvasAgentHistoryQuery(canvasId)

  const [timeline, setTimelineState] = useState<AgentTimelineState>(createAgentTimeline)
  const timelineRef = useRef(timeline)
  const [streaming, setStreaming] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [disconnected, setDisconnected] = useState(false)
  const [confirmations, setConfirmations] = useState<ConfirmationMap>(createConfirmationState)
  const confirmationsRef = useRef(confirmations)
  confirmationsRef.current = confirmations
  const [applyFeedback, setApplyFeedback] = useState<ApplyFeedback | null>(null)

  const actorRef = useRef(actorId)
  const latestRef = useRef({ actorId, canvasId })
  useEffect(() => {
    latestRef.current = { actorId, canvasId }
  }, [actorId, canvasId])

  /** Single synchronous writer for the timeline so async callbacks read the same
   *  state the setter just produced (used by the done→apply ordering check). */
  const updateTimeline = useCallback(
    (reducer: (previous: AgentTimelineState) => AgentTimelineState) => {
      const next = reducer(timelineRef.current)
      timelineRef.current = next
      setTimelineState(next)
    },
    [],
  )

  const invalidateConversation = useCallback(() => {
    const { actorId: actor, canvasId: canvas } = latestRef.current
    if (actor && canvas) void queryClient.invalidateQueries({ queryKey: canvasAgentHistoryQueryKey(actor, canvas) })
  }, [queryClient])

  const applyMutation = useMutation({
    mutationFn: (turnId: string) => {
      const canvas = latestRef.current.canvasId
      if (!canvas) throw new Error('缺少对话')
      return canvasApi.apply(canvas, turnId)
    },
    onSuccess: (result) => {
      setApplyFeedback(describeApplyResult(result))
      const { actorId: actor, canvasId: canvas } = latestRef.current
      if (actor && canvas) {
        void queryClient.invalidateQueries({ queryKey: canvasAgentHistoryQueryKey(actor, canvas) })
        void queryClient.invalidateQueries({ queryKey: ['canvases', actor, 'detail', canvas] })
      }
      // Applying a scene commits asset/node relations, so the shared job and library
      // reads are refreshed from the server instead of being trusted to have gone
      // stale. Scoped to the two roots the commit can move — nothing else.
      void queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY })
    },
    onError: (error) => {
      setApplyFeedback({ applied: false, revision: 0, opCount: 0, message: applyFailureMessage(error) })
    },
  })
  const applyRef = useRef(applyMutation)
  applyRef.current = applyMutation

  // Managed-apply bookkeeping. A turn id is recorded the moment apply is attempted
  // (live `done`, a resolved confirmation, or post-history recovery), so no path can
  // commit the same turn twice in one session — including a page that refetches and
  // re-merges the same turn after the first attempt.
  const applyAttemptedTurnIdsRef = useRef<Set<string>>(new Set())
  /** The newest ops turn already seen by recovery; only a strictly newer one re-arms. */
  const applyRecoveryNewestRef = useRef<string | null>(null)
  /** Actor the active dispatch belongs to, so an in-place actor change cannot let a
   *  stale frame through even when the canvas id happens to be reused. */
  const dispatchActorRef = useRef('')
  const requestApply = useCallback((turnId: string | null | undefined) => {
    if (!turnId) return
    if (applyAttemptedTurnIdsRef.current.has(turnId)) return
    applyAttemptedTurnIdsRef.current.add(turnId)
    applyRef.current.mutate(turnId)
  }, [])

  const confirmMutation = useMutation({
    mutationFn: (input: { pendingId: string; approve: boolean }) => {
      const canvas = latestRef.current.canvasId
      if (!canvas) throw new Error('缺少对话')
      return canvasApi.confirm(canvas, input.pendingId, input.approve)
    },
  })

  // The one send path for this conversation. Created once; its handlers read live
  // actor/canvas facts from refs so a stale closure can never target the old actor.
  const senderRef = useRef<ComposerSender | null>(null)
  if (!senderRef.current) {
    senderRef.current = createComposerSender({
      stream: (targetCanvasId, request, signal) =>
        streamAgentEvents(API_ENDPOINTS.canvases.agent.messages(targetCanvasId), request, { signal }),
      onRequest: (request, canvas) => {
        if (canvas !== latestRef.current.canvasId || dispatchActorRef.current !== latestRef.current.actorId) return
        setStreaming(true)
        setStreamError(null)
        setDisconnected(false)
        if (request.kind === 'user') {
          updateTimeline((previous) => appendUserMessage(previous, {
            id: request.messageId,
            text: request.text,
            contextSummary: request.context,
            createdAt: new Date().toISOString(),
          }))
        }
      },
      onEvent: (event, canvas) => {
        // A switch aborts the stream, but an event already read could still be in
        // flight; it must not leak into the new conversation or trigger an apply
        // against the new canvas. The actor check covers an in-place actor change
        // that reuses the same canvas id.
        if (canvas !== latestRef.current.canvasId || dispatchActorRef.current !== latestRef.current.actorId) return
        updateTimeline((previous) => applyAgentTimelineEvent(previous, event))
        // Apply ordering: a completed agent-managed turn with ops and no pending is
        // committed now; a pending keeps the revision frozen until it is decided.
        if (event.type === 'done' && shouldApplyTurn(timelineRef.current, event.turnId, event.message.ops?.length ?? 0)) {
          requestApply(event.turnId)
        }
      },
      onSettled: (outcome, canvas) => {
        // A stale stream settling must not clear the new conversation's streaming
        // state or reload its history.
        if (canvas !== latestRef.current.canvasId || dispatchActorRef.current !== latestRef.current.actorId) return
        setStreaming(false)
        if (outcome.status === 'error') {
          if (outcome.error instanceof AgentStreamHttpError) setStreamError(outcome.error.message)
          else if (outcome.error instanceof AgentStreamDisconnectedError) setDisconnected(true)
          else setStreamError(outcome.error instanceof Error ? outcome.error.message : 'Agent 请求失败')
        }
        // Re-read persisted facts after any terminal outcome; a disconnect is exactly
        // the case where the server may know more than the client received.
        invalidateConversation()
      },
    }, createAgentSubmitLock())
  }

  // A different conversation is a different timeline. Without this reset, switching
  // canvas would merge the new history into the previous conversation's items — and
  // the recovery below would offer to apply a turn against the wrong canvas.
  const previousCanvasIdRef = useRef(canvasId)
  useEffect(() => {
    const previous = previousCanvasIdRef.current
    previousCanvasIdRef.current = canvasId
    // Creating the first conversation (null -> id) keeps the optimistic turn the
    // send that created it just appended; only a switch between conversations (or
    // back to none) starts clean.
    if (previous === null || previous === canvasId) return
    // Leaving a conversation abandons its in-flight turn: abort it so it cannot
    // write into the new timeline or apply its turn against the new canvas, then
    // clear every piece of the old conversation's state.
    senderRef.current?.stop()
    updateTimeline(() => createAgentTimeline())
    applyAttemptedTurnIdsRef.current = new Set()
    applyRecoveryNewestRef.current = null
    setApplyFeedback(null)
    setStreaming(false)
    setStreamError(null)
    setDisconnected(false)
    setConfirmations(createConfirmationState())
  }, [canvasId, updateTimeline])

  // Fold persisted history into the timeline. Idempotent, so a refetch after a turn
  // (or a replayed page) updates items in place instead of duplicating them.
  useEffect(() => {
    const pages = historyQuery.data?.pages
    if (!pages || pages.length === 0) return
    updateTimeline((previous) => {
      let next = previous
      for (const page of [...pages].reverse()) {
        next = mergeHistoryPage(next, page.messages as AgentMessageDto[], page.pendingJobs)
      }
      return next
    })
  }, [historyQuery.data, updateTimeline])

  // Bounded apply recovery after the first history load of a conversation. A
  // completed agent-managed turn whose live `done` never arrived (disconnect,
  // reload) still carries its ops in the persisted history, and no other path
  // would ever commit them. Recovery is keyed on the newest ops turn: a refetch or
  // a backward page that only adds older pre-existing turns changes nothing, while
  // a genuinely newer turn (a mid-session disconnect) re-arms exactly one pass.
  // A re-armed pass may only apply that newer turn — falling through to an older
  // pre-existing turn would only conflict against an advanced revision. The
  // per-turn attempt set still guarantees no turn is applied twice; the
  // switch/actor effects reset the marker.
  useEffect(() => {
    if (streaming) return
    if (!historyQuery.data) return
    const opsTurns = unappliedOpsTurnIds(timelineRef.current)
    if (opsTurns.length === 0) return
    const newest = opsTurns[opsTurns.length - 1]!
    if (applyRecoveryNewestRef.current === newest) return
    applyRecoveryNewestRef.current = newest
    const turnId = planApplyRecovery(timelineRef.current, applyAttemptedTurnIdsRef.current)
    if (turnId !== newest) return
    requestApply(turnId)
  }, [timeline, streaming, historyQuery.data, requestApply])

  // Actor switch: abort the in-flight stream, clear the previous actor's timeline,
  // confirmations and cached conversation state. Runs again when logout clears the
  // actor to ''.
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
    applyAttemptedTurnIdsRef.current = new Set()
    applyRecoveryNewestRef.current = null
    if (previous) {
      for (const prefix of actorScopedCanvasQueryKeys(previous)) {
        queryClient.removeQueries({ queryKey: prefix })
      }
    }
  }, [actorId, queryClient, updateTimeline])

  useEffect(() => () => {
    senderRef.current?.stop()
  }, [])

  /** Confirm or reject one immutable proposal; reconcile from the response, and on a
   *  conflict/expiry surface a new-proposal state instead of retrying. */
  const confirmPending = useCallback((pendingId: string, approve: boolean) => {
    if (confirmationFor(confirmationsRef.current, pendingId).phase === 'submitting') return
    setConfirmations((map) => beginConfirmation(map, pendingId, approve ? 'confirm' : 'reject'))
    confirmMutation.mutate({ pendingId, approve }, {
      onSuccess: (result) => {
        updateTimeline((previous) => applyPendingSnapshot(previous, result.pending))
        setConfirmations((map) => confirmationSucceeded(map, result))
        invalidateConversation()
        // Once the proposal is decided the turn has no actionable pending left, so a
        // turn that staged ops can be committed now (the revision was frozen until
        // this point). `turnId` may be absent on legacy rows: then it is not applied.
        // A submitted proposal has also produced a job row, so the shared job list is
        // refreshed so the result card can resolve it from one source.
        void queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY })
        const turnId = result.pending.turnId
        if (turnId && shouldApplyTurn(timelineRef.current, turnId)) requestApply(turnId)
      },
      onError: (error) => {
        setConfirmations((map) => confirmationFailed(map, pendingId, error))
        invalidateConversation()
      },
    })
  }, [confirmMutation, invalidateConversation, updateTimeline, requestApply, queryClient])

  /** Send a structured composer draft as one Agent turn. Returns `false`
   *  synchronously when the lock is held or the draft is empty. */
  const send = useCallback((draft: ComposerDraft, baseRevision: number, targetCanvasId?: string) => {
    const canvas = targetCanvasId ?? latestRef.current.canvasId
    if (!canvas || !senderRef.current) return false
    // Keep the live canvas/actor facts in step with the dispatch so the stream
    // guards compare against the conversation this turn actually targets, even when
    // the state effect for a just-created conversation has not run yet.
    latestRef.current = { ...latestRef.current, canvasId: canvas }
    dispatchActorRef.current = latestRef.current.actorId
    return senderRef.current.sendUserMessage({ canvasId: canvas, baseRevision, draft })
  }, [])

  /** Explicit job_event continuation (user click or enabled opt-in only). */
  const continuePlanning = useCallback((jobId: string, baseRevision: number) => {
    const canvas = latestRef.current.canvasId
    if (!canvas || !senderRef.current) return false
    dispatchActorRef.current = latestRef.current.actorId
    return senderRef.current.sendJobEvent({ canvasId: canvas, baseRevision, jobId })
  }, [])

  /** Aborts only the current Agent turn; a media job is cancelled separately. */
  const stop = useCallback(() => {
    senderRef.current?.stop()
  }, [])

  const availability = resolveAgentAvailability(statusQuery.data)

  return {
    actorId,
    timeline,
    streaming,
    streamError,
    disconnected,
    send,
    stop,
    continuePlanning,
    confirmPending,
    confirmations,
    applyFeedback,
    apply: applyMutation,
    status: statusQuery,
    availability,
    history: {
      query: historyQuery,
      messages: historyQuery.data?.pages ?? [],
      loading: historyQuery.isLoading,
      error: historyQuery.error,
      hasOlder: historyQuery.hasNextPage,
      loadOlder: historyQuery.fetchNextPage,
      reload: historyQuery.refetch,
    },
  }
}

export type CanvasAgentController = ReturnType<typeof useCanvasAgent>
export type { AgentStreamEvent }
