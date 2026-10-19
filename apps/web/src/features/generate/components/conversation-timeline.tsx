'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDownIcon } from '@phosphor-icons/react'
import { Alert, Button, Spinner } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import { AgentMessage } from './agent-message'
import type { PendingTimelineItem, TimelineItem } from '../lib/agent-turn-state'

/** How close to the bottom still counts as "following along". */
const NEAR_BOTTOM_PX = 120

export interface ConversationTimelineProps {
  items: TimelineItem[]
  streaming: boolean
  disconnected: boolean
  streamError: string | null
  /** Pending proposals are rendered by the caller so the timeline stays unaware of
   *  confirmation wiring. */
  renderPending: (item: PendingTimelineItem) => ReactNode
  emptyHint?: string
  className?: string
}

/**
 * The one main scroll region for the conversation. Auto-scroll only happens while
 * the user is already near the bottom, so reading older messages is never stolen;
 * otherwise a reachable "new content" button appears. A single polite live region
 * announces only key states (streaming / disconnected / pending count) — never
 * per-delta text.
 */
export function ConversationTimeline({
  items,
  streaming,
  disconnected,
  streamError,
  renderPending,
  emptyHint = '描述你想创作的内容，Agent 会规划并在确认后执行。',
  className,
}: ConversationTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastCountRef = useRef(0)
  const [nearBottom, setNearBottom] = useState(true)
  const [hasNew, setHasNew] = useState(false)

  const pendingCount = useMemo(() => items.filter((item) => item.kind === 'pending').length, [items])

  function measure() {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distance <= NEAR_BOTTOM_PX
    setNearBottom(atBottom)
    if (atBottom) setHasNew(false)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const grew = items.length > lastCountRef.current
    lastCountRef.current = items.length
    if (!grew) return
    if (nearBottom) el.scrollTop = el.scrollHeight
    else setHasNew(true)
  }, [items.length, nearBottom])

  function scrollToBottom() {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setHasNew(false)
    setNearBottom(true)
  }

  const announcement = disconnected
    ? '连接中断。任务可能已在后台创建，请刷新历史确认，不会自动重发。'
    : streamError
      ? 'Agent 请求失败，请查看错误信息。'
      : streaming
        ? 'Agent 正在回复。'
        : pendingCount > 0
          ? `有 ${pendingCount} 项待确认的生成提案。`
          : ''

  return (
    <section aria-label="对话" className={cn('relative mx-auto flex min-h-0 w-full max-w-[760px] min-w-0 flex-1 flex-col', className)}>
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {disconnected ? (
        <Alert tone="warning" title="连接已中断" className="mb-3">
          连接在完成前中断，任务可能已在后台创建。请刷新历史确认，不会自动重发请求。
        </Alert>
      ) : null}
      {streamError ? (
        <Alert tone="danger" title="Agent 请求失败" role="alert" className="mb-3">{streamError}</Alert>
      ) : null}
      <div
        ref={scrollRef}
        onScroll={measure}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1 py-2"
      >
        {items.length === 0 ? (
          <p className="m-auto max-w-reading text-center text-sm text-muted-foreground">{emptyHint}</p>
        ) : (
          items.map((item) => (
            // Each entry eases in once, when it first arrives; existing entries keep
            // their keys and never replay the entrance during streaming.
            <div key={item.id} className="motion-reveal">
              {item.kind === 'pending' ? renderPending(item) : <AgentMessage item={item} />}
            </div>
          ))
        )}
        {streaming ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden="true">
            <Spinner size="sm" />
            <span>Agent 正在回复…</span>
          </div>
        ) : null}
      </div>
      {hasNew && !nearBottom ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
          <Button variant="secondary" size="sm" className="pointer-events-auto shadow-floating" onClick={scrollToBottom} icon={<ArrowDownIcon weight="bold" aria-hidden="true" />}>
            有新内容
          </Button>
        </div>
      ) : null}
    </section>
  )
}
