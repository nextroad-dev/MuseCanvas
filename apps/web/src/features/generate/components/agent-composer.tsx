'use client'

import { useEffect, useRef } from 'react'
import { PaperPlaneRightIcon, StopCircleIcon } from '@phosphor-icons/react'
import { Alert, Button, IconButton, Textarea, iconSize } from '@/shared/components/ui'
import type { ImageInputPlan, ImageInputPlanModel } from '@/shared/lib/generation-params'
import type { ParameterCarrier, ParameterState, ParameterValue } from '@/shared/lib/media-parameters'
import type { DefaultAwareModel } from '@/shared/lib/model-capabilities'
import type { GenerateModeTab } from '@/shared/types'
import type { ComposerDraft, ComposerIntent } from '../lib/agent-composer'
import { MediaParameterControls } from './media-parameter-controls'
import { ModelPicker } from './model-picker'
import { ReferenceImagesTrigger } from './reference-images-trigger'
import { cn } from '@/shared/lib/cn'

/** Long drafts scroll *inside* the textarea instead of stretching the composer. */
const MAX_TEXTAREA_PX = 200

export interface AgentComposerProps {
  draft: ComposerDraft
  onDraftChange: (next: ComposerDraft) => void
  imageModels: DefaultAwareModel[]
  videoModels: DefaultAwareModel[]
  /** The kind the composer currently submits as; a video pick switches it. */
  activeKind: GenerateModeTab
  selectedModelIdByKind: Record<GenerateModeTab, string>
  onSelectModel: (kind: GenerateModeTab, id: string) => void
  parameterModel: ParameterCarrier | null | undefined
  values: ParameterState
  onParameterChange: (name: string, value: ParameterValue) => void
  countUnit?: string
  modelsLoading: boolean
  modelStatus: string | null
  modelsFailed: boolean
  onReloadModels: () => void
  inputModel: ImageInputPlanModel | null | undefined
  inputPlan: ImageInputPlan
  inputsDisabled: boolean
  canGenerate: boolean
  sending: boolean
  blockedReason: string | null
  onSubmit: () => void
  onStop: () => void
  onRemoveEditSource: () => void
  className?: string
}

/**
 * The Agent composer. It authors *context* — text, explicit intent, model,
 * descriptor-built parameters, role-positioned inputs and an optional edit source —
 * and never submits a generation itself; the single send path builds a
 * confirmation-gated, agent-managed request from this draft.
 *
 * Measurement only runs while the textarea is laid out (a hidden element reports a
 * 0 scrollHeight), Cmd/Ctrl+Enter submits only outside an IME composition, and
 * feedback is rendered inline rather than in a second nested scroll band.
 */
export function AgentComposer({
  draft,
  onDraftChange,
  imageModels,
  videoModels,
  activeKind,
  selectedModelIdByKind,
  onSelectModel,
  parameterModel,
  values,
  onParameterChange,
  countUnit,
  modelsLoading,
  modelStatus,
  modelsFailed,
  onReloadModels,
  inputModel,
  inputPlan,
  inputsDisabled,
  canGenerate,
  sending,
  blockedReason,
  onSubmit,
  onStop,
  onRemoveEditSource,
  className,
}: AgentComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    // `offsetParent === null` means the composer is not visible yet; measuring then
    // would collapse it to one row when it is shown again.
    if (!el || el.offsetParent === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [draft.text])

  const editSource = draft.editSource
  const intent: ComposerIntent = editSource ? 'edit' : draft.intent

  function patch(next: Partial<ComposerDraft>) {
    onDraftChange({ ...draft, ...next })
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (!blockedReason && canGenerate && !sending) onSubmit()
    }
  }

  return (
    <section aria-label="给 Agent 的创作请求" className={cn('flex shrink-0 flex-col gap-2 rounded-panel border border-border bg-surface p-3 shadow-floating', className)}>
      <fieldset disabled={sending} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <Textarea
          ref={textareaRef}
          id="agent-message"
          rows={2}
          value={draft.text}
          disabled={sending}
          onChange={(event) => patch({ text: event.target.value })}
          onKeyDown={onKeyDown}
          placeholder={intent === 'edit' ? '例如：将框选区域改为红色风衣，其余保持不变…' : '描述你想要生成的画面，例如：清晨江边小镇，薄雾、木质渡船…'}
          aria-describedby="agent-message-help"
          className="min-h-[var(--control-md)] resize-none overflow-y-auto border-0 bg-transparent p-1 text-sm leading-relaxed focus-visible:ring-0"
        />

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 overflow-x-auto">
            {modelsLoading && imageModels.length === 0 && videoModels.length === 0 ? (
              <p role="status" className="truncate text-xs text-muted-foreground">加载模型中…</p>
            ) : (
              <ModelPicker
                imageModels={imageModels}
                videoModels={videoModels}
                activeKind={activeKind}
                selectedModelIdByKind={selectedModelIdByKind}
                onSelect={onSelectModel}
                disabled={sending}
              />
            )}
            <MediaParameterControls
              model={parameterModel}
              values={values}
              onChange={onParameterChange}
              countUnit={countUnit}
              disabled={sending}
              showLabels={false}
            />
            <ReferenceImagesTrigger model={inputModel} plan={inputPlan} disabled={sending || inputsDisabled} />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {sending ? (
              <Button type="button" variant="secondary" size="sm" onClick={onStop} icon={<StopCircleIcon weight="bold" aria-hidden="true" />}>
                停止
              </Button>
            ) : null}
            <IconButton
              type="button"
              variant="primary"
              size="md"
              aria-label="发送生成任务"
              onClick={onSubmit}
              disabled={sending || !canGenerate || Boolean(blockedReason) || draft.text.trim().length === 0}
              loading={sending}
              className="rounded-pill"
              icon={<PaperPlaneRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
            />
          </div>
        </div>
      </fieldset>

      {editSource ? (
        <p className="text-xs text-muted-foreground">
          已附加选区草稿（{editSource.selection.width}×{editSource.selection.height} 像素），发送时随消息作为上下文提交，不会直接执行。
          <Button type="button" variant="ghost" size="sm" className="ml-1 underline underline-offset-2" onClick={onRemoveEditSource}>移除</Button>
        </p>
      ) : null}

      {modelStatus ? (
        <p role={modelsFailed ? 'alert' : 'status'} className="text-xs text-muted-foreground">
          {modelStatus}
          {modelsFailed ? (
            <Button type="button" variant="ghost" size="sm" onClick={onReloadModels} className="ml-1 underline underline-offset-2">重载模型</Button>
          ) : null}
        </p>
      ) : null}

      {blockedReason ? (
        <Alert tone="info" role="status">{blockedReason}</Alert>
      ) : null}

      <p id="agent-message-help" className="sr-only">Ctrl/⌘ + Enter 发送 · 参数与参考图只作为 Agent 上下文，不会直接生成</p>
    </section>
  )
}
