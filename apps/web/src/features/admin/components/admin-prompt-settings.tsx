'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CanvasAgentSettingsDto } from '@musecanvas/contracts'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Field, FieldGroup } from '@/shared/components/ui/field'
import { Input } from '@/shared/components/ui/input'
import { Select } from '@/shared/components/ui/select'
import { Switch } from '@/shared/components/ui/switch'
import { useToast } from '@/shared/components/ui/toast'
import { queryKeys } from '@/shared/hooks/query-keys'
import { formatDateTime } from '@/shared/lib/format'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import type { AdminModelDto, PromptOptimizationSettingsDto } from '@/shared/types'
import { clientApi } from '@/shared/services/client-api'

/** 语言模型下拉：停用模型仍列出但标注状态，避免保存后才报错找不到。 */
function LanguageModelSelect({
  value,
  models,
  disabled,
  onChange,
}: {
  value: string
  models: AdminModelDto[]
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <Select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">未选择语言模型</option>
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.displayName}
          {model.enabled ? '' : '（已停用）'}
        </option>
      ))}
    </Select>
  )
}

export interface AdminPromptOptimizationCardProps {
  models: AdminModelDto[]
}

/** 提示词优化设置：启用开关、最终提示词可读性、语言模型选择；超时固定 600 秒。 */
export function AdminPromptOptimizationCard({ models }: AdminPromptOptimizationCardProps) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [enabled, setEnabled] = useState(false)
  const [allowUserReadFinalPrompt, setAllowUserReadFinalPrompt] = useState(false)
  const [modelId, setModelId] = useState('')

  const settingsQuery = useQuery({
    queryKey: queryKeys.admin.promptOptimizationSettings,
    queryFn: () => clientApi.admin.getPromptOptimizationSettings(),
    staleTime: 30_000,
  })
  const settings: PromptOptimizationSettingsDto | undefined = settingsQuery.data

  useEffect(() => {
    if (!settings) return
    setEnabled(settings.enabled)
    setAllowUserReadFinalPrompt(settings.allowUserReadFinalPrompt)
    setModelId(settings.languageModelConfigId ?? '')
  }, [settings])

  const mutation = useMutation({
    mutationFn: (input: { enabled: boolean; allowUserReadFinalPrompt: boolean; languageModelConfigId: string | null }) =>
      clientApi.admin.updatePromptOptimizationSettings(input),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.admin.promptOptimizationSettings, saved)
      toast.success('提示词优化设置已保存')
    },
    onError: (error) => toast.error('保存提示词优化设置失败', adminErrorMessage(error)),
  })

  function handleSave() {
    if (enabled && !modelId) {
      toast.error('启用前请先选择语言模型')
      return
    }
    mutation.mutate({ enabled, allowUserReadFinalPrompt, languageModelConfigId: modelId || null })
  }

  return (
    <Card aria-labelledby="admin-prompt-optimization-title">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle id="admin-prompt-optimization-title" level={2}>
            提示词优化
          </CardTitle>
          <Badge tone={enabled ? 'success' : 'neutral'} dot>
            {settingsQuery.isLoading ? '读取中' : enabled ? '已启用' : '已停用'}
          </Badge>
        </div>
        <CardDescription>
          生成前用语言模型把用户描述改写成更完整的提示词；超时固定 600 秒。停用后使用用户原始描述。
        </CardDescription>
      </CardHeader>
      <CardBody>
        <FieldGroup className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-tonal px-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">启用提示词优化</span>
              <span className="text-xs text-muted-foreground">启用后每次生成会额外调用一次语言模型。</span>
            </div>
            <Switch
              aria-label="启用提示词优化"
              checked={enabled}
              disabled={settingsQuery.isLoading || mutation.isPending}
              onCheckedChange={setEnabled}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control px-1">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">允许用户查看最终提示词</span>
              <span className="text-xs text-muted-foreground">开启后作品详情会展示优化后的最终提示词。</span>
            </div>
            <Switch
              aria-label="允许用户查看最终提示词"
              checked={allowUserReadFinalPrompt}
              disabled={settingsQuery.isLoading || mutation.isPending}
              onCheckedChange={setAllowUserReadFinalPrompt}
            />
          </div>

          <Field label="语言模型" hint="使用 /admin/language-models 中已启用的语言模型。">
            <LanguageModelSelect
              value={modelId}
              models={models}
              disabled={settingsQuery.isLoading || mutation.isPending}
              onChange={setModelId}
            />
          </Field>

          {settings ? (
            <p className="font-mono text-xs text-muted-foreground">
              超时 {Math.round(settings.timeoutMs / 1000)} 秒 · 更新于 {formatDateTime(settings.updatedAt)}
            </p>
          ) : null}
        </FieldGroup>
      </CardBody>
      <CardFooter>
        <span className="text-xs text-muted-foreground">启用状态需要选择可用语言模型才能保存。</span>
        <Button onClick={handleSave} loading={mutation.isPending} disabled={settingsQuery.isLoading}>
          保存提示词优化
        </Button>
      </CardFooter>
    </Card>
  )
}

export interface AdminPromptAgentCardProps {
  models: AdminModelDto[]
}

const AGENT_LIMITS = {
  maxToolCallsPerTurn: { min: 1, max: 32, label: '单回合工具调用上限' },
  maxJobsPerTurn: { min: 1, max: 8, label: '单回合生成任务上限' },
  timeoutMs: { min: 1_000, max: 300_000, label: '单回合超时（秒）' },
  maxAutoContinuations: { min: 0, max: 10, label: '自动续跑轮数上限' },
} as const

/** 创作助手（canvas agent）设置：启停、语言模型与单回合护栏。 */
export function AdminPromptAgentCard({ models }: AdminPromptAgentCardProps) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [enabled, setEnabled] = useState(false)
  const [modelId, setModelId] = useState('')
  const [toolCalls, setToolCalls] = useState('')
  const [jobs, setJobs] = useState('')
  const [timeoutSeconds, setTimeoutSeconds] = useState('')
  const [autoContinuations, setAutoContinuations] = useState('')
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})

  const settingsQuery = useQuery({
    queryKey: queryKeys.admin.canvasAgentSettings,
    queryFn: () => clientApi.admin.getCanvasAgentSettings(),
    staleTime: 30_000,
  })
  const settings: CanvasAgentSettingsDto | undefined = settingsQuery.data

  useEffect(() => {
    if (!settings) return
    setEnabled(settings.enabled)
    setModelId(settings.languageModelConfigId ?? '')
    setToolCalls(String(settings.maxToolCallsPerTurn))
    setJobs(String(settings.maxJobsPerTurn))
    setTimeoutSeconds(String(Math.round(settings.timeoutMs / 1000)))
    setAutoContinuations(String(settings.maxAutoContinuations))
    setErrors({})
  }, [settings])

  const mutation = useMutation({
    mutationFn: (input: {
      enabled: boolean
      languageModelConfigId: string | null
      maxToolCallsPerTurn: number
      maxJobsPerTurn: number
      timeoutMs: number
      maxAutoContinuations: number
    }) => clientApi.admin.updateCanvasAgentSettings(input),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.admin.canvasAgentSettings, saved)
      toast.success('创作助手设置已保存')
    },
    onError: (error) => toast.error('保存创作助手设置失败', adminErrorMessage(error)),
  })

  function handleSave() {
    const nextErrors: Record<string, string | undefined> = {}
    if (enabled && !modelId) nextErrors.modelId = '启用前请先选择语言模型。'

    const parsed = {
      maxToolCallsPerTurn: Number(toolCalls),
      maxJobsPerTurn: Number(jobs),
      timeoutMs: Number(timeoutSeconds) * 1000,
      maxAutoContinuations: Number(autoContinuations),
    }
    for (const [key, limit] of Object.entries(AGENT_LIMITS)) {
      const value = parsed[key as keyof typeof parsed]
      const numeric = Number.isFinite(value) ? value : NaN
      const min = key === 'timeoutMs' ? limit.min / 1000 : limit.min
      const max = key === 'timeoutMs' ? limit.max / 1000 : limit.max
      if (!Number.isInteger(numeric) && key !== 'timeoutMs') {
        nextErrors[key] = `${limit.label}必须是整数。`
      } else if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
        nextErrors[key] = `${limit.label}取值范围是 ${min} - ${max}。`
      }
    }
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) return

    mutation.mutate({
      enabled,
      languageModelConfigId: modelId || null,
      maxToolCallsPerTurn: parsed.maxToolCallsPerTurn,
      maxJobsPerTurn: parsed.maxJobsPerTurn,
      timeoutMs: parsed.timeoutMs,
      maxAutoContinuations: parsed.maxAutoContinuations,
    })
  }

  return (
    <Card aria-labelledby="admin-agent-settings-title">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle id="admin-agent-settings-title" level={2}>
            创作助手（Canvas Agent）
          </CardTitle>
          <Badge tone={enabled ? 'success' : 'neutral'} dot>
            {settingsQuery.isLoading ? '读取中' : enabled ? '已启用' : '已停用'}
          </Badge>
        </div>
        <CardDescription>
          创作台的对话式生成助手：需要支持工具调用的语言模型。停用后创作台回退到手动参数面板。
        </CardDescription>
      </CardHeader>
      <CardBody>
        <FieldGroup className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-tonal px-4 py-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">启用创作助手</span>
              <span className="text-xs text-muted-foreground">关闭后 /generate 只提供表单式生成。</span>
            </div>
            <Switch
              aria-label="启用创作助手"
              checked={enabled}
              disabled={settingsQuery.isLoading || mutation.isPending}
              onCheckedChange={setEnabled}
            />
          </div>

          <Field label="语言模型" error={errors.modelId} hint="必须是支持工具调用（tool calling）的语言模型。">
            <LanguageModelSelect
              value={modelId}
              models={models}
              disabled={settingsQuery.isLoading || mutation.isPending}
              onChange={setModelId}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={AGENT_LIMITS.maxToolCallsPerTurn.label} error={errors.maxToolCallsPerTurn} hint="1 - 32">
              <Input
                value={toolCalls}
                onChange={(event) => setToolCalls(event.target.value)}
                inputMode="numeric"
                disabled={mutation.isPending}
              />
            </Field>
            <Field label={AGENT_LIMITS.maxJobsPerTurn.label} error={errors.maxJobsPerTurn} hint="1 - 8">
              <Input
                value={jobs}
                onChange={(event) => setJobs(event.target.value)}
                inputMode="numeric"
                disabled={mutation.isPending}
              />
            </Field>
            <Field label={AGENT_LIMITS.timeoutMs.label} error={errors.timeoutMs} hint="1 - 300 秒">
              <Input
                value={timeoutSeconds}
                onChange={(event) => setTimeoutSeconds(event.target.value)}
                inputMode="numeric"
                disabled={mutation.isPending}
              />
            </Field>
            <Field label={AGENT_LIMITS.maxAutoContinuations.label} error={errors.maxAutoContinuations} hint="0 - 10">
              <Input
                value={autoContinuations}
                onChange={(event) => setAutoContinuations(event.target.value)}
                inputMode="numeric"
                disabled={mutation.isPending}
              />
            </Field>
          </div>

          {settings ? (
            <p className="font-mono text-xs text-muted-foreground">更新于 {formatDateTime(settings.updatedAt)}</p>
          ) : null}
        </FieldGroup>
      </CardBody>
      <CardFooter>
        <span className="text-xs text-muted-foreground">工具/任务上限越低，单回合越安全但能做的事越少。</span>
        <Button onClick={handleSave} loading={mutation.isPending} disabled={settingsQuery.isLoading}>
          保存创作助手设置
        </Button>
      </CardFooter>
    </Card>
  )
}
