'use client'

import { useEffect, useState } from 'react'
import { SparkleIcon } from '@phosphor-icons/react'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  Select,
  Switch,
  controlSquare,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import {
  useAdminPromptOptimizationSettings,
  useUpdateAdminPromptOptimizationSettings,
} from '@/shared/hooks/useAdmin'
import { cn } from '@/shared/lib/cn'
import { formatDateTime } from '@/shared/lib/format'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import type { AdminModelDto, PromptOptimizationSettingsDto } from '@/shared/types'

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
  const { toast } = useToast()
  const [enabled, setEnabled] = useState(false)
  const [allowUserReadFinalPrompt, setAllowUserReadFinalPrompt] = useState(false)
  const [modelId, setModelId] = useState('')

  const settingsQuery = useAdminPromptOptimizationSettings()
  const settings: PromptOptimizationSettingsDto | undefined = settingsQuery.data

  useEffect(() => {
    if (!settings) return
    setEnabled(settings.enabled)
    setAllowUserReadFinalPrompt(settings.allowUserReadFinalPrompt)
    setModelId(settings.languageModelConfigId ?? '')
  }, [settings])

  const mutation = useUpdateAdminPromptOptimizationSettings()

  function handleSave() {
    if (enabled && !modelId) {
      toast.error('启用前请先选择语言模型')
      return
    }
    // 严格遵守契约：仅发送 { enabled, allowUserReadFinalPrompt, languageModelConfigId }
    mutation.mutate(
      {
        enabled,
        allowUserReadFinalPrompt,
        languageModelConfigId: modelId || null,
      },
      {
        onSuccess: () => {
          toast.success('提示词优化设置已保存')
        },
        onError: (error) => toast.error('保存提示词优化设置失败', adminErrorMessage(error)),
      },
    )
  }

  return (
    <Card aria-labelledby="admin-prompt-optimization-title">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent',
              controlSquare.md,
            )}
          >
            <SparkleIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
          </div>
        </div>
      </CardHeader>
      <CardBody>
        <FieldGroup className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border/70 bg-tonal px-4 py-3">
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

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border/70 bg-tonal px-4 py-3">
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

          <Field label="语言模型" hint="从当前实例已配置并启用的语言模型中选择。">
            <LanguageModelSelect
              value={modelId}
              models={models}
              disabled={settingsQuery.isLoading || mutation.isPending}
              onChange={setModelId}
            />
          </Field>

          {settings ? (
            <p className="font-mono text-xs tabular-nums text-muted-foreground">
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
