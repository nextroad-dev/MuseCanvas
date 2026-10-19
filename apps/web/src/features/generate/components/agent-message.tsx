'use client'

import { useState } from 'react'
import { ArrowRightIcon, CheckCircleIcon, WarningCircleIcon, WrenchIcon, XCircleIcon } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { iconSize } from '@/shared/components/ui'
import type { JsonValue } from '@musecanvas/contracts'
import type {
  AssistantTimelineItem,
  CanvasOpsTimelineItem,
  ErrorTimelineItem,
  ToolTimelineItem,
  UserTimelineItem,
} from '../lib/agent-turn-state'

/** One-line, plain-text summary of the structured context a user message carried.
 *  Only safe, already-public fields: intent, an explicit model id, attachment
 *  count, and an edit selection. Never URLs, secrets or provider details. */
function contextSummaryLines(summary: UserTimelineItem['contextSummary']): string[] {
  if (!summary) return []
  const lines: string[] = []
  if (summary.intent) lines.push(`意图：${summary.intent === 'generate' ? '生成' : summary.intent === 'edit' ? '编辑' : '继续'}`)
  if (summary.modelId) lines.push(`指定模型：${summary.modelId}`)
  if (summary.inputs?.length) lines.push(`附件：${summary.inputs.length} 项`)
  if (summary.editSource) {
    const { selection } = summary.editSource
    lines.push(`选区：${selection.width}×${selection.height} @ (${selection.x}, ${selection.y})`)
  }
  return lines
}

function JsonBlock({ label, value }: { label: string; value: JsonValue }) {
  const [expanded, setExpanded] = useState(false)
  const text = JSON.stringify(value, null, 2)
  // The collapsed cap is ~6 lines at this size; anything longer (or a long single
  // line that wraps past it) needs an explicit way to reveal the rest, or it would
  // be clipped with no affordance.
  const lineCount = text.split('\n').length
  const needsToggle = lineCount > 6 || text.length > 160
  // Collapsing caps the height without a nested scroll band: the conversation
  // timeline stays the single scroll region, and the full JSON flows in it when
  // expanded.
  return (
    <div className="flex flex-col gap-1">
      <pre className={cn('whitespace-pre-wrap break-words rounded-control bg-surface p-2 font-mono text-caption text-muted-foreground', !expanded && 'max-h-24 overflow-hidden')}>{text}</pre>
      {needsToggle ? (
        <button type="button" className="self-start text-caption text-muted-foreground underline underline-offset-2" onClick={() => setExpanded((current) => !current)}>
          {expanded ? `收起${label}` : `展开${label}`}
        </button>
      ) : null}
    </div>
  )
}

function ToolEntry({ item }: { item: ToolTimelineItem }) {
  const status = item.success === null ? '执行中' : item.success ? '成功' : '失败'
  const Icon = item.success === null ? WrenchIcon : item.success ? CheckCircleIcon : XCircleIcon
  return (
    <article className="flex flex-col gap-1 rounded-control border border-border-control bg-tonal px-3 py-2" aria-label={`工具 ${item.name ?? item.toolCallId}`}>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Icon weight="bold" aria-hidden="true" className={cn(iconSize.sm, 'shrink-0')} />
        <span className="truncate font-medium text-foreground">{item.name ?? '工具调用'}</span>
        <span aria-hidden="true">·</span>
        <span>{status}</span>
        <span className="ml-auto truncate font-mono text-caption text-muted-foreground" title={item.toolCallId}>{item.toolCallId}</span>
      </div>
      {item.arguments ? <JsonBlock label="调用参数" value={item.arguments} /> : null}
      {item.result !== null ? <JsonBlock label="工具结果" value={item.result} /> : null}
    </article>
  )
}

function CanvasOpsProposal({ item }: { item: CanvasOpsTimelineItem }) {
  return (
    <article className="flex flex-col gap-1 rounded-control border border-dashed border-border-strong bg-transparent px-3 py-2" aria-label="画布改动提案">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ArrowRightIcon weight="bold" aria-hidden="true" className={cn(iconSize.sm, 'shrink-0')} />
        <span className="font-medium text-foreground">提案 · {item.ops.length} 项画布改动</span>
        <span>基准版本 {item.baseRevision}</span>
      </div>
      <p className="text-xs text-muted-foreground">提案不会立即写入画布，待本轮结束后按服务端记录提交。</p>
    </article>
  )
}

function ErrorEntry({ item }: { item: ErrorTimelineItem }) {
  return (
    <article role="alert" className="flex flex-col gap-1 rounded-control border border-danger-border bg-danger-soft px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-danger">
        <WarningCircleIcon weight="fill" aria-hidden="true" className={cn(iconSize.sm, 'shrink-0')} />
        <span className="font-mono">{item.code}</span>
        {item.retryable ? <span>可重试</span> : <span>请调整后重试</span>}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{item.message}</p>
    </article>
  )
}

export interface AgentMessageProps {
  item: UserTimelineItem | AssistantTimelineItem | ToolTimelineItem | CanvasOpsTimelineItem | ErrorTimelineItem
}

/** One conversation entry. Tool results and canvas proposals render as their own
 *  entries — never folded into assistant prose. All text is plain (no Markdown,
 *  no HTML) and preserves newlines. */
export function AgentMessage({ item }: AgentMessageProps) {
  if (item.kind === 'tool') return <ToolEntry item={item} />
  if (item.kind === 'canvas_ops') return <CanvasOpsProposal item={item} />
  if (item.kind === 'error') return <ErrorEntry item={item} />

  if (item.kind === 'user') {
    const lines = contextSummaryLines(item.contextSummary)
    return (
      <article className="flex flex-col items-end gap-1" aria-label="你的消息">
        <div className="max-w-[520px] rounded-card bg-tonal px-4 py-3 text-sm text-foreground">
          <p className="whitespace-pre-wrap break-words">{item.text}</p>
        </div>
        {lines.length > 0 ? (
          <ul className="flex max-w-[520px] flex-col gap-0.5 text-right text-caption text-muted-foreground">
            {lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : null}
      </article>
    )
  }

  // The agent speaks as open text, not a bubble: only the user's turns are boxed, so
  // the timeline reads as one conversation instead of a stack of cards.
  return (
    <article className="flex max-w-[620px] flex-col gap-1" aria-label="Agent 回复">
      <p className="text-xs font-medium text-muted-foreground">Agent</p>
      <div className={cn('text-sm leading-relaxed text-foreground', item.provisional && 'opacity-90')}>
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
      </div>
      {item.provisional ? <p className="text-caption text-muted-foreground">生成中…</p> : null}
    </article>
  )
}
