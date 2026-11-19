'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { CpuIcon } from '@phosphor-icons/react'
import type { MediaKind, PublicModelDto } from '@musecanvas/contracts'

import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  Select,
  Skeleton,
  controlSquare,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import {
  useAdminMediaModelDefaults,
  useUpdateAdminMediaModelDefaults,
} from '@/shared/hooks/useAdmin'
import { useModels } from '@/shared/hooks/useModels'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { formatDateTime } from '@/shared/lib/format'
import { adminErrorMessage } from '../lib/admin-settings-api-error'
import {
  buildMediaModelDefaultsRequest,
  type MediaModelDefaultsSelection,
} from '../lib/media-model-defaults-form'

function ModelSelect({
  kind,
  label,
  value,
  models,
  disabled,
  onChange,
}: {
  kind: MediaKind
  label: string
  value: string
  models: PublicModelDto[]
  disabled: boolean
  onChange: (value: string) => void
}) {
  const options = models.filter((model) => model.modelKind === kind && model.enabled)
  const currentMissing = Boolean(value) && !options.some((model) => model.id === value)
  return (
    <Field
      label={label}
      hint="仅列出已启用的对应类型模型；留空表示本次不修改。"
    >
      <Select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">本次不修改</option>
        {currentMissing ? <option value={value}>当前默认（模型已不可用）</option> : null}
        {options.map((model) => (
          <option key={model.id} value={model.id}>
            {model.displayName}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/**
 * 默认媒体模型配置卡（GET / PATCH `/api/admin/media-model-defaults`）。
 *
 * 完整保留 `media-model-defaults-form.ts` 的校验与增量 PATCH 语义：
 * 空选项或未修改的字段不发送，绝不向后端发送 `null`。
 */
export function AdminMediaModelDefaultsCard({ className }: { className?: string }) {
  const { toast } = useToast()
  const defaultsQuery = useAdminMediaModelDefaults()
  const modelsQuery = useModels()
  const updateMutation = useUpdateAdminMediaModelDefaults()

  const [selection, setSelection] = useState<MediaModelDefaultsSelection>({
    imageModelId: '',
    videoModelId: '',
  })

  const defaults = defaultsQuery.data
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data])

  useEffect(() => {
    if (!defaults) return
    setSelection({
      imageModelId: defaults.imageModelId ?? '',
      videoModelId: defaults.videoModelId ?? '',
    })
  }, [defaults])

  const request = useMemo(
    () => (defaults ? buildMediaModelDefaultsRequest(defaults, selection) : {}),
    [defaults, selection],
  )
  const hasChanges = Object.keys(request).length > 0

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!hasChanges || updateMutation.isPending) return
    updateMutation.mutate(request, {
      onSuccess: (saved) => {
        setSelection({
          imageModelId: saved.imageModelId ?? '',
          videoModelId: saved.videoModelId ?? '',
        })
        toast.success('默认媒体模型已更新', '新生成任务将按对应类型的默认模型解析。')
      },
      onError: (error) => {
        toast.error('更新默认媒体模型失败', adminErrorMessage(error))
      },
    })
  }

  const loading = defaultsQuery.isPending || modelsQuery.isPending
  const loadError = defaultsQuery.isError || modelsQuery.isError
  const isReady = Boolean(defaults?.imageModelId && defaults?.videoModelId)

  return (
    <Card aria-labelledby="admin-media-defaults-title" className={cn('border border-border', className)}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent',
                controlSquare.md,
              )}
            >
              <CpuIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
            </span>
            <div className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle id="admin-media-defaults-title" level={2}>
                  默认媒体模型
                </CardTitle>
                {defaults ? (
                  <Badge tone={isReady ? 'success' : 'warning'} dot>
                    {isReady ? '两类已配置' : '部分待配置'}
                  </Badge>
                ) : null}
              </div>
              <CardDescription>
                为图像与视频生成分别选举默认模型。默认只能替换，未修改的类型不会提交。
              </CardDescription>
            </div>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href={APP_ROUTES.adminModels}>模型管理</Link>
          </Button>
        </div>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardBody>
          {loading ? (
            <div className="grid gap-4 md:grid-cols-2" role="status" aria-label="正在加载默认媒体模型">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : loadError || !defaults ? (
            <Alert
              tone="danger"
              title="默认模型配置加载失败"
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void defaultsQuery.refetch()
                    void modelsQuery.refetch()
                  }}
                >
                  重试
                </Button>
              }
            >
              {adminErrorMessage(defaultsQuery.error ?? modelsQuery.error, '请检查管理员会话与网络后重试。')}
            </Alert>
          ) : (
            <div className="grid gap-5 md:grid-cols-2">
              <ModelSelect
                kind="image"
                label="默认图像模型"
                value={selection.imageModelId}
                models={models}
                disabled={updateMutation.isPending}
                onChange={(imageModelId) => setSelection((current) => ({ ...current, imageModelId }))}
              />
              <ModelSelect
                kind="video"
                label="默认视频模型"
                value={selection.videoModelId}
                models={models}
                disabled={updateMutation.isPending}
                onChange={(videoModelId) => setSelection((current) => ({ ...current, videoModelId }))}
              />
            </div>
          )}
        </CardBody>
        <CardFooter className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {defaults ? `更新于 ${formatDateTime(defaults.updatedAt)}` : '等待配置数据'}
          </span>
          <Button type="submit" loading={updateMutation.isPending} disabled={!hasChanges || loading || loadError}>
            保存默认模型
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

export const AdminMediaModelDefaults = AdminMediaModelDefaultsCard
