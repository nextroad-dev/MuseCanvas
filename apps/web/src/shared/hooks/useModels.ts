'use client'

// 模型目录（GET /models）：含 isDefault / capabilities / 描述符。
// 目录变更低频，staleTime 5 分钟；后台改默认模型后可手动 invalidate。

import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { clientApi } from '@/shared/services/client-api'
import type { MediaKind, PublicModelDto } from '@/shared/types'
import { queryKeys } from './query-keys'
import { resolveActiveModel } from '@/shared/lib/model-capabilities'

export function useModels(): UseQueryResult<PublicModelDto[]> {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: () => clientApi.models.list(),
    staleTime: 5 * 60_000,
  })
}

/** 某类型下当前应使用的模型：rememberedId → isDefault → 首个非 deprecated。 */
export function useActiveModel(
  kind: MediaKind,
  storedId: string | null,
): { model: PublicModelDto | null; models: PublicModelDto[]; isLoading: boolean } {
  const query = useModels()
  const models = query.data ?? []
  return {
    model: resolveActiveModel(models, kind, storedId),
    models,
    isLoading: query.isLoading,
  }
}
