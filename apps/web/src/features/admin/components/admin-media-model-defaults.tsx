'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { MediaModelDefaultsDto } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { AdminModel } from '@/shared/types'
import { requireAdminData } from '../lib/admin-query'
import {
  MEDIA_MODEL_DEFAULTS_QUERY_KEY,
  PUBLIC_MODELS_QUERY_KEY,
  defaultIdForKind,
  defaultsPatchForKind,
  defaultsSaveError,
  enabledModelsByKind,
  patchMediaModelDefaults,
  type MediaDefaultKind,
} from '../lib/admin-media-model-defaults'
import { AdminQueryFeedback } from './admin-query-feedback'
import {
  Alert,
  Button,
  Card,
  CardTitle,
  FormField,
  Select,
  SkeletonText,
  useToast,
} from '@/shared/components/ui'

const KINDS: MediaDefaultKind[] = ['image', 'video']
const KIND_SELECT_LABEL: Record<MediaDefaultKind, string> = {
  image: '默认图像模型',
  video: '默认视频模型',
}

interface AdminMediaModelDefaultsProps {
  /** Media rows from the page's admin model list; only enabled rows are offered. */
  models: AdminModel[]
}

/**
 * The one PATCH path for 默认模型, shared by the defaults card and the table's「设为默认」.
 * Refreshes the public model list and the defaults; toast and error copy stay with each caller.
 * Errors are re-thrown with the mapped copy and the server code kept on the Error.
 */
export function useMediaModelDefaultSave() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ kind, id }: { kind: MediaDefaultKind; id: string }) => {
      try {
        return await patchMediaModelDefaults(api, API_ENDPOINTS.admin.mediaModelDefaults, defaultsPatchForKind(kind, id))
      } catch (err) {
        const failure = err as { code?: string; message?: string }
        throw Object.assign(new Error(defaultsSaveError(failure)), { code: failure.code })
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PUBLIC_MODELS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: MEDIA_MODEL_DEFAULTS_QUERY_KEY }),
      ])
    },
  })
}

/**
 * 默认模型卡（设计稿 08 首模块）。两列 Select 只列启用对应类型，改动即时 PATCH；
 * 成功 toast「默认模型已更新」并刷新创作台与本卡，失败回滚选择并显示错误。
 */
export function AdminMediaModelDefaults({ models }: AdminMediaModelDefaultsProps) {
  const toast = useToast()
  const [error, setError] = useState('')
  // Optimistic selection while the PATCH is in flight; cleared on settle so the
  // server row stays the single source of truth (failure rolls back to it).
  const [pending, setPending] = useState<Partial<Record<MediaDefaultKind, string>>>({})

  const {
    data: defaults,
    isLoading,
    isError,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: MEDIA_MODEL_DEFAULTS_QUERY_KEY,
    queryFn: async () =>
      requireAdminData(
        await api<MediaModelDefaultsDto>(API_ENDPOINTS.admin.mediaModelDefaults),
        '加载默认模型失败',
      ),
  })

  const save = useMediaModelDefaultSave()

  function handleChange(kind: MediaDefaultKind, id: string) {
    if (!id || save.isPending) return
    if (defaultIdForKind(defaults, kind) === id) return
    setError('')
    setPending((previous) => ({ ...previous, [kind]: id }))
    save.mutate(
      { kind, id },
      {
        onSuccess: () => {
          setPending({})
          setError('')
          toast.push({ variant: 'success', title: '默认模型已更新' })
        },
        onError: (err) => {
          // Roll back the optimistic selection to the server row.
          setPending({})
          setError(err.message)
        },
      },
    )
  }

  const busy = save.isPending

  return (
    <section aria-labelledby="media-defaults-heading" className="flex min-w-0 flex-col gap-4">
      {defaults !== undefined && (
        <AdminQueryFeedback error={queryError} hasData label="默认模型" onRetry={() => refetch()} />
      )}
      <Card className="gap-5 p-6">
        <div className="flex flex-col gap-1">
          <CardTitle level={2} id="media-defaults-heading" className="text-foreground">
            默认模型
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            用户新建对话时预选这两个模型；用户手动切换后，那个对话以用户的选择为准。
          </p>
        </div>
        {isLoading || defaults === undefined ? (
          isError && defaults === undefined ? (
            <Alert
              tone="danger"
              role="alert"
              title="无法加载默认模型"
              action={<Button variant="secondary" size="sm" onClick={() => refetch()}>刷新重试</Button>}
            >
              {queryError instanceof Error ? queryError.message : '加载默认模型失败'}。请检查后端服务状态后重试。
            </Alert>
          ) : (
            <div role="status" aria-busy="true" aria-label="正在加载默认模型" className="grid min-w-0 gap-6 grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
              <span className="sr-only">正在加载默认模型</span>
              <div className="flex flex-col gap-2" aria-hidden="true">
                <SkeletonText width="8rem" />
                <SkeletonText width="16rem" />
              </div>
              <div className="flex flex-col gap-2" aria-hidden="true">
                <SkeletonText width="8rem" />
                <SkeletonText width="16rem" />
              </div>
            </div>
          )
        ) : (
          <div className="grid min-w-0 gap-6 grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
            {KINDS.map((kind) => {
              const options = enabledModelsByKind(models, kind)
              const serverId = defaultIdForKind(defaults, kind)
              const value = pending[kind] ?? serverId ?? ''
              return (
                <FormField key={kind} label={KIND_SELECT_LABEL[kind]}>
                  <Select
                    value={value}
                    disabled={busy || options.length === 0}
                    aria-label={KIND_SELECT_LABEL[kind]}
                    aria-busy={busy || undefined}
                    onChange={(event) => handleChange(kind, event.target.value)}
                  >
                    <option value="">
                      {options.length === 0
                        ? `暂无已启用的${kind === 'image' ? '图像' : '视频'}模型`
                        : '请选择默认模型'}
                    </option>
                    {options.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName}
                      </option>
                    ))}
                    {serverId && !options.some((model) => model.id === serverId) ? (
                      <option value={serverId}>当前默认模型已停用（{serverId.slice(0, 8)}…），请选择其他模型</option>
                    ) : null}
                  </Select>
                </FormField>
              )
            })}
          </div>
        )}
        {defaults !== undefined ? (
          <p className="text-xs text-muted-foreground">
            只能选择已启用的模型。停用默认模型前，需要先指定另一个默认模型。
          </p>
        ) : null}
        {error ? (
          <Alert tone="danger" role="alert" title="无法保存默认模型">
            {error}
          </Alert>
        ) : null}
      </Card>
    </section>
  )
}
