'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { CanvasAgentSettingsDto } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { AdminModel } from '@/shared/types'
import { requireAdminData } from '../lib/admin-query'
import {
  CANVAS_AGENT_NUMERIC_FIELDS,
  CANVAS_AGENT_SETTING_LIMITS,
  canvasAgentDraftChanged,
  canvasAgentSaveError,
  canvasAgentSettingsDraft,
  hasNewerCanvasAgentSettings,
  validateCanvasAgentDraft,
  type CanvasAgentSettingsDraft,
  type CanvasAgentSettingsErrors,
} from '../lib/canvas-agent-settings-state'
import { AdminQueryFeedback } from './admin-query-feedback'
import { ArrowClockwiseIcon as RefreshCw } from '@phosphor-icons/react'
import {
  Alert,
  Badge,
  Button,
  CardDescription,
  CardTitle,
  FieldGroup,
  FormField,
  Input,
  Select,
  SkeletonText,
  SkeletonTile,
  Switch,
  iconSize,
} from '@/shared/components/ui'

const canvasAgentSettingsQueryKey = ['admin', 'canvas-agent-settings'] as const
const FORM_ID = 'admin-settings-canvas-agent-form'

const FIELD_LABELS: Record<(typeof CANVAS_AGENT_NUMERIC_FIELDS)[number], { label: string; hint: string }> = {
  maxToolCallsPerTurn: { label: '单轮工具调用上限', hint: '每轮对话允许的最大工具调用次数。' },
  maxJobsPerTurn: { label: '单轮生成任务上限', hint: '每轮对话允许排入的最大生成任务数。' },
  timeoutMs: { label: '单轮超时（毫秒）', hint: '一次模型请求的最长等待时间。' },
  maxAutoContinuations: { label: '自动续轮上限', hint: '模型可未经用户输入自行继续的轮数；0 表示不自动续轮。' },
}

interface Feedback {
  ok: boolean
  msg: string
}

export interface AdminCanvasAgentSettingsProps {
  /** Reports this tab's dirty/busy state to the settings page (for its badges and guards). */
  onStateChange?: (state: { dirty: boolean; busy: boolean }) => void
}

function modelOptionLabel(model: AdminModel): string {
  const protocol = model.languageProtocol || '未知协议'
  return `${model.displayName}（${protocol}，${model.enabled ? '已启用' : '已停用'}）`
}

/**
 * Canvas Agent settings, mounted as a settings tab (no separate admin route).
 * The form is dirty-state driven: nothing is sent until 保存, and the save is a
 * single PATCH — it never opens a provider connection or runs a connectivity test.
 * Model identity comes from the admin language-model list; the section never
 * invents models, auto-enables the feature, or auto-binds a model.
 */
export function AdminCanvasAgentSettings({ onStateChange }: AdminCanvasAgentSettingsProps) {
  const queryClient = useQueryClient()
  const [settings, setSettings] = useState<CanvasAgentSettingsDto | null>(null)
  const [draft, setDraft] = useState<CanvasAgentSettingsDraft | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const {
    data: latestSettings,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: canvasAgentSettingsQueryKey,
    queryFn: async () =>
      requireAdminData(
        await api<CanvasAgentSettingsDto>(API_ENDPOINTS.admin.canvasAgentSettings),
        '读取 Canvas Agent 设置失败',
      ),
  })

  const {
    data: modelsData,
    isError: modelsError,
    error: modelsQueryError,
    refetch: refetchModels,
  } = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: async () => requireAdminData(await api<AdminModel[]>(API_ENDPOINTS.admin.models), '加载语言模型列表失败'),
  })

  // The admin model list is the only source of selectable models: no literal ids,
  // no placeholder "default" model. Only language models are offered.
  const languageModels = (modelsData ?? []).filter((model) => model.modelKind === 'language')
  const availableModelIds = languageModels.map((model) => model.id)

  useEffect(() => {
    // Adopt the fetched row only as the initial baseline; a background refetch
    // updates `latestSettings` but never overwrites an in-progress draft.
    if (!latestSettings || settings) return
    setSettings(latestSettings)
    setDraft(canvasAgentSettingsDraft(latestSettings))
  }, [latestSettings, settings])

  function load(next: CanvasAgentSettingsDto) {
    setSettings(next)
    setDraft(canvasAgentSettingsDraft(next))
    setFeedback(null)
  }

  const dirty = settings && draft ? canvasAgentDraftChanged(draft, settings) : false
  const validation = draft ? validateCanvasAgentDraft(draft, availableModelIds) : null
  const errors: CanvasAgentSettingsErrors = validation?.errors ?? {}

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error('设置尚未加载完成，请稍后重试')
      const result = validateCanvasAgentDraft(draft, availableModelIds)
      if (!result.payload) throw new Error(result.firstError || '请检查表单中的错误')
      const res = await api<CanvasAgentSettingsDto>(API_ENDPOINTS.admin.canvasAgentSettings, {
        method: 'PATCH',
        body: result.payload,
      })
      if (!res.success) throw new Error(canvasAgentSaveError(res.error))
      return requireAdminData(res, '保存响应缺少设置数据')
    },
    onSuccess: async (data) => {
      load(data)
      setFeedback({ ok: true, msg: 'Canvas Agent 设置已保存。保存不会连接或调用任何模型。' })
      queryClient.setQueryData(canvasAgentSettingsQueryKey, data)
      await queryClient.invalidateQueries({ queryKey: canvasAgentSettingsQueryKey })
    },
    onError: (err: Error) => setFeedback({ ok: false, msg: err.message || '保存 Canvas Agent 设置失败' }),
  })

  const busy = save.isPending
  useEffect(() => { onStateChange?.({ dirty, busy }) }, [dirty, busy, onStateChange])

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border pb-6">
      <div className="flex min-w-0 flex-col gap-1">
        <CardTitle level={2}>Canvas Agent</CardTitle>
        <CardDescription>
          画布内 AI 助手的启用状态、语言模型与每轮护栏参数。默认停用且不绑定模型。
        </CardDescription>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {settings ? (
          <Badge tone={settings.enabled ? 'success' : 'neutral'}>{settings.enabled ? '已启用' : '已停用'}</Badge>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          loading={isFetching}
          disabled={busy}
          onClick={() => { if (!busy) void refetch() }}
          icon={<RefreshCw weight="bold" aria-hidden="true" className={iconSize.sm} />}
        >
          刷新
        </Button>
      </div>
    </div>
  )

  if (isLoading && !settings) {
    return (
      <div role="status" aria-busy="true" aria-label="正在加载 Canvas Agent 设置" className="flex min-w-0 flex-col gap-4">
        <span className="sr-only">正在加载 Canvas Agent 设置</span>
        <section className="@container/fields flex min-w-0 flex-col gap-6">
          <SkeletonText width="12rem" />
          <SkeletonText lines={2} />
          <div className="flex flex-col gap-6">
            {[0, 1].map((index) => (
              <div key={index} className="flex flex-col gap-2">
                <SkeletonText width="8rem" />
                <SkeletonTile className="aspect-auto h-10 w-full rounded-control" />
              </div>
            ))}
          </div>
        </section>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-surface p-4 shadow-floating">
          <SkeletonText width="10rem" />
          <SkeletonTile className="aspect-auto h-10 w-32 rounded-control" />
        </div>
      </div>
    )
  }

  if (isError && !settings) {
    return (
      <Alert
        tone="danger"
        role="alert"
        title="无法加载 Canvas Agent 设置"
        action={<Button variant="secondary" size="sm" loading={isFetching} onClick={() => void refetch()}>刷新重试</Button>}
      >
        {error instanceof Error ? error.message : '读取 Canvas Agent 设置失败'}。请稍后重试。
      </Alert>
    )
  }

  if (!settings || !draft) return null

  const reloadServerSettings = () => {
    if (!latestSettings) return
    load(latestSettings)
  }

  return (
    <>
      {feedback ? <Alert tone={feedback.ok ? 'success' : 'danger'} role={feedback.ok ? 'status' : 'alert'}>{feedback.msg}</Alert> : null}
      {hasNewerCanvasAgentSettings(settings.updatedAt, latestSettings?.updatedAt ?? settings.updatedAt) ? (
        <Alert tone="info" title="服务端设置已更新" action={
          <Button variant="secondary" disabled={busy} onClick={reloadServerSettings}>载入服务端设置</Button>
        }>
          当前草稿已保留；载入会替换本分区草稿并采用服务端版本。
        </Alert>
      ) : null}
      <AdminQueryFeedback error={error ?? null} hasData label="Canvas Agent 设置" onRetry={() => void refetch()} />
      <AdminQueryFeedback error={modelsQueryError ?? null} hasData={modelsData !== undefined} label="语言模型列表" onRetry={() => void refetchModels()} />

      <section className="@container/fields flex min-w-0 flex-col gap-6">
        {header}
        <form
          id={FORM_ID}
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy && dirty) save.mutate()
          }}
        >
          <fieldset disabled={busy} className="min-w-0">
            <FieldGroup>
              <div className="flex items-start justify-between gap-4 rounded-control border border-border bg-tonal p-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium text-foreground">启用 Canvas Agent</span>
                  <p className="max-w-reading text-xs text-muted-foreground">
                    停用后画布内的 AI 助手不可用。启用前必须选择一个可用的语言模型；保存设置本身不会连接模型。
                  </p>
                </div>
                <Switch
                  checked={draft.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) => setDraft((prev) => (prev ? { ...prev, enabled } : prev))}
                  aria-label="启用 Canvas Agent"
                />
              </div>

              <FormField
                label="语言模型"
                hint="来自管理后台的语言模型列表；仅内置 openai_chat / anthropic_messages 模型且凭据可用时服务端才会接受。未绑定模型时不能启用。"
                error={errors.languageModelConfigId}
              >
                <Select
                  value={draft.languageModelConfigId}
                  disabled={busy || (modelsError && modelsData === undefined)}
                  onChange={(e) => setDraft((prev) => (prev ? { ...prev, languageModelConfigId: e.target.value } : prev))}
                >
                  <option value="">不绑定语言模型</option>
                  {languageModels.map((model) => (
                    <option key={model.id} value={model.id}>{modelOptionLabel(model)}</option>
                  ))}
                  {/* The persisted binding may be absent from the loaded catalog (deleted
                      model, or the list request failed): keep it visible and explicit
                      instead of silently clearing the row. */}
                  {draft.languageModelConfigId && !languageModels.some((model) => model.id === draft.languageModelConfigId) ? (
                    <option value={draft.languageModelConfigId}>当前绑定的模型已不在可用列表中（{draft.languageModelConfigId}）</option>
                  ) : null}
                </Select>
              </FormField>

              {modelsData !== undefined && languageModels.length === 0 ? (
                <Alert tone="info" title="尚未配置语言模型">
                  后台还没有可用的语言模型。请先在「语言模型」页创建并启用模型与凭据，再回到这里绑定；在绑定模型前 Canvas Agent 无法启用。
                </Alert>
              ) : null}

              <div className="grid min-w-0 gap-6 @min-[560px]/fields:grid-cols-2">
                {CANVAS_AGENT_NUMERIC_FIELDS.map((field) => (
                  <FormField
                    key={field}
                    label={FIELD_LABELS[field].label}
                    hint={`${FIELD_LABELS[field].hint}允许范围 ${CANVAS_AGENT_SETTING_LIMITS[field].min}–${CANVAS_AGENT_SETTING_LIMITS[field].max}。`}
                    error={errors[field]}
                  >
                    <Input
                      type="number"
                      min={CANVAS_AGENT_SETTING_LIMITS[field].min}
                      max={CANVAS_AGENT_SETTING_LIMITS[field].max}
                      step={1}
                      value={draft[field]}
                      onChange={(e) => setDraft((prev) => (prev ? { ...prev, [field]: e.target.value } : prev))}
                    />
                  </FormField>
                ))}
              </div>
            </FieldGroup>
          </fieldset>
        </form>
      </section>

      <div className="sticky bottom-0 z-sticky flex flex-wrap items-center justify-between gap-3 rounded-card bg-surface p-4 shadow-floating">
        <p role="status" className="text-sm text-muted-foreground">
          {busy ? '本分区操作中，表单已锁定。' : dirty ? '有未保存的更改。' : '当前没有可提交的更改。'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            className="min-h-[var(--control-lg)] md:min-h-[var(--control-md)]"
            disabled={busy || !dirty}
            onClick={() => setDraft(canvasAgentSettingsDraft(settings))}
          >
            取消
          </Button>
          <Button
            type="submit"
            className="min-h-[var(--control-lg)] md:min-h-[var(--control-md)]"
            form={FORM_ID}
            loading={save.isPending}
            disabled={busy || !dirty}
          >
            保存
          </Button>
        </div>
      </div>
    </>
  )
}
