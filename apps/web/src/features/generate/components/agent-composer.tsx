'use client'

import { useEffect, useRef } from 'react'
import { SparkleIcon, StopCircleIcon, XIcon } from '@phosphor-icons/react'
import { Alert, Button, IconButton, SegmentedControl, Select, Textarea, iconSize } from '@/shared/components/ui'
import type { ModelConfig } from '@/shared/types'
import type { ImageInputPlan, ImageInputPlanModel } from '@/shared/lib/generation-params'
import type { ParameterCarrier, ParameterState, ParameterValue } from '@/shared/lib/media-parameters'
import type { ComposerDraft, ComposerIntent } from '../lib/agent-composer'
import { MediaParameterControls } from './media-parameter-controls'
import { ReferenceImagesTrigger } from './reference-images-trigger'

/** Long drafts scroll *inside* the textarea instead of stretching the composer. */
const MAX_TEXTAREA_PX = 200

export interface AgentComposerProps {
  draft: ComposerDraft
  onDraftChange: (next: ComposerDraft) => void
  models: ModelConfig[]
  modelId: string
  parameterModel: ParameterCarrier | null | undefined
  values: ParameterState
  onModelChange: (id: string) => void
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
  models,
  modelId,
  parameterModel,
  values,
  onModelChange,
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
    <section aria-label="给 Agent 的创作请求" className="flex shrink-0 flex-col gap-3 rounded-panel bg-surface p-3 shadow-floating md:p-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">创作请求（Agent 上下文）</h2>
        {sending ? (
          <Button type="button" variant="secondary" size="sm" onClick={onStop} icon={<StopCircleIcon weight="bold" aria-hidden="true" />}>
            停止本轮 Agent
          </Button>
        ) : null}
      </div>

      <fieldset disabled={sending} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <div className="flex flex-wrap items-end gap-3">
          <SegmentedControl
            label="意图"
            size="sm"
            value={intent}
            onChange={(value) => patch({ intent: value as ComposerIntent })}
            items={[
              { value: 'generate', label: '生成' },
              { value: 'edit', label: '编辑' },
            ]}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="agent-model" className="text-overline text-muted-foreground">模型</label>
            <Select
              id="agent-model"
              size="sm"
              width="content"
              className="max-w-full"
              value={modelId}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={sending || modelsLoading || models.length === 0}
            >
              {modelsLoading && <option value="">加载模型中…</option>}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}{model.deprecated ? `（已弃用${model.deprecationNote ? `：${model.deprecationNote}` : ''}）` : ''}
                </option>
              ))}
              {!modelsLoading && models.length === 0 && <option value="">尚未配置模型</option>}
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <ReferenceImagesTrigger model={inputModel} plan={inputPlan} disabled={sending || inputsDisabled} />
          <MediaParameterControls
            model={parameterModel}
            values={values}
            onChange={onParameterChange}
            countUnit={countUnit}
            disabled={sending}
          />
        </div>

        {editSource ? (
          <p className="text-xs text-muted-foreground">
            已附加选区草稿（{editSource.selection.width}×{editSource.selection.height} 像素），发送时随消息作为上下文提交，不会直接执行。
            <Button type="button" variant="ghost" size="sm" className="ml-1 underline underline-offset-2" onClick={onRemoveEditSource}>移除</Button>
          </p>
        ) : null}

        <div className="flex flex-col gap-1">
          <label htmlFor="agent-message" className="text-xs text-muted-foreground">消息</label>
          <Textarea
            ref={textareaRef}
            id="agent-message"
            rows={2}
            value={draft.text}
            disabled={sending}
            onChange={(event) => patch({ text: event.target.value })}
            onKeyDown={onKeyDown}
            placeholder={intent === 'edit' ? '例如：将框选区域改为红色风衣，其余保持不变…' : '描述你想创作的内容，Agent 会规划并在确认后执行。'}
            aria-describedby="agent-message-help"
            className="min-h-[var(--control-md)] resize-none overflow-y-auto text-sm leading-relaxed"
          />
          <p id="agent-message-help" className="text-xs text-muted-foreground">Ctrl/⌘ + Enter 发送 · 参数与参考图只作为 Agent 上下文，不会直接生成</p>
        </div>
      </fieldset>

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

      <div className="flex items-center justify-end gap-2">
        <IconButton
          type="button"
          variant="ghost"
          size="sm"
          aria-label="清空消息"
          disabled={sending || draft.text.length === 0}
          onClick={() => patch({ text: '' })}
          icon={<XIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
        />
        <Button
          type="button"
          variant="primary"
          onClick={onSubmit}
          disabled={sending || !canGenerate || Boolean(blockedReason) || draft.text.trim().length === 0}
          loading={sending}
          icon={<SparkleIcon weight="bold" aria-hidden="true" />}
        >
          发送给 Agent
        </Button>
      </div>
    </section>
  )
}
