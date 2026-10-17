'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { MediaModelDefaultsDto } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { AdminModel } from '@/shared/types'
import { adminTouchWrap } from '../lib/admin-layout'
import { requireAdminData } from '../lib/admin-query'
import { AdminQueryFeedback } from './admin-query-feedback'
import { Button, Card, SkeletonText, buttonVariants } from '@/shared/components/ui'

/** Short id fallback when the model list fails but a default id is known. */
function shortId(id: string): string {
  return `${id.slice(0, 8)}…`
}

export function AdminDefaultModelsCard() {
  const {
    data: defaults,
    isLoading: defaultsLoading,
    isError: isDefaultsError,
    error: defaultsError,
    refetch: refetchDefaults,
  } = useQuery({
    queryKey: ['admin', 'media-model-defaults'],
    queryFn: async () => {
      const res = await api<MediaModelDefaultsDto>(API_ENDPOINTS.admin.mediaModelDefaults)
      return requireAdminData(res, '加载默认模型失败')
    },
  })

  const {
    data: modelsData,
    isLoading: modelsLoading,
    isError: isModelsError,
    error: modelsError,
    refetch: refetchModels,
  } = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: async () => {
      const res = await api<AdminModel[]>(API_ENDPOINTS.admin.models)
      return requireAdminData(res, '加载模型列表失败')
    },
  })

  const loading = defaultsLoading || modelsLoading
  const models = modelsData ?? []
  const nameOf = (id: string | null): string | null => {
    if (!id) return null
    return models.find((model) => model.id === id)?.displayName ?? null
  }

  const imageId = defaults?.imageModelId ?? null
  const videoId = defaults?.videoModelId ?? null
  const imageName = nameOf(imageId)
  const videoName = nameOf(videoId)
  const missing = !loading && defaults !== undefined && (imageId === null || videoId === null)

  function renderValue(id: string | null, name: string | null) {
    if (name) return <span className="font-medium text-foreground">{name}</span>
    if (id) {
      // Defaults are known but the model list failed: show the id, not “unset”.
      return <span className="font-mono text-sm text-muted-foreground">{shortId(id)}</span>
    }
    return <span className="font-medium text-warning">未设置</span>
  }

  return (
    <section aria-labelledby="admin-default-models-heading" className={`flex min-w-0 flex-col gap-4 ${adminTouchWrap}`}>
      {defaults !== undefined && (
        <AdminQueryFeedback
          error={defaultsError ?? modelsError}
          hasData
          label="默认模型"
          onRetry={() => {
            refetchDefaults()
            refetchModels()
          }}
        />
      )}
      <Card className="flex-row flex-wrap items-center justify-between gap-x-8 gap-y-4 p-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-2">
          <h2 id="admin-default-models-heading" className="shrink-0 text-base font-bold text-foreground">
            默认模型
          </h2>
          {defaults === undefined && (isDefaultsError || isModelsError) ? (
            <div className="flex min-w-0 flex-col gap-2">
              <p className="text-sm text-danger">
                {defaultsError?.message || modelsError?.message || '加载默认模型失败'}
                。请检查后端服务状态后重试。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    refetchDefaults()
                    refetchModels()
                  }}
                >
                  刷新重试
                </Button>
              </div>
            </div>
          ) : loading || defaults === undefined ? (
            <div className="flex min-w-0 flex-wrap gap-x-8 gap-y-2" aria-hidden="true">
              <SkeletonText width="12rem" />
              <SkeletonText width="12rem" />
            </div>
          ) : (
            <dl className="flex min-w-0 flex-wrap gap-x-8 gap-y-2">
              <div className="flex items-baseline gap-2.5">
                <dt className="text-sm text-muted-foreground">图像</dt>
                <dd className="m-0 text-sm">{renderValue(imageId, imageName)}</dd>
              </div>
              <div className="flex items-baseline gap-2.5">
                <dt className="text-sm text-muted-foreground">视频</dt>
                <dd className="m-0 text-sm">{renderValue(videoId, videoName)}</dd>
              </div>
            </dl>
          )}
        </div>
        {missing ? (
          <p role="status" className="w-full text-xs text-warning">
            有媒体类型尚未设置默认模型，新对话将回落到第一个可用模型。请去设置页指定。
          </p>
        ) : null}
        <Link href="/admin/media-models" className={buttonVariants({ variant: 'secondary' })}>
          去设置
        </Link>
      </Card>
    </section>
  )
}
