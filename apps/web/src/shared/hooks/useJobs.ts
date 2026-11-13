'use client'

// 任务列表/详情 + 取消/重试。列表在有进行中任务时按 JOB_POLL_MS 轮询；
// 401 立即停轮询（避免过期会话下持续 401 风暴），全部终态也停。

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { clientApi } from '@/shared/services/client-api'
import { isApiError } from '@/shared/services/api'
import { isJobActive } from '@/shared/lib/job-status'
import { cacheCreatedJob } from '@/shared/lib/created-job-cache'
import type {
  GenerationJobDto,
  GenerationJobListDto,
  JobFilters,
} from '@/shared/types'
import { JOB_POLL_MS, queryKeys } from './query-keys'

export { JOB_POLL_MS }

function filterJobs(items: GenerationJobDto[], filters?: JobFilters): GenerationJobDto[] {
  let list = items
  if (filters?.status === 'active') list = list.filter((job) => isJobActive(job))
  else if (filters?.status) list = list.filter((job) => job.status === filters.status)
  return filters?.limit ? list.slice(0, filters.limit) : list
}

/** GET /jobs（后端固定最近 50 条）；filters 为客户端筛选 + 轮询提示。 */
export function useJobs(filters?: JobFilters): UseQueryResult<GenerationJobListDto> {
  return useQuery({
    queryKey: queryKeys.jobs.list(filters),
    queryFn: async () => {
      const page = await clientApi.jobs.list()
      const items = filterJobs(page.items, filters)
      return { items, total: page.total, hasMore: page.hasMore }
    },
    refetchInterval: (query) => {
      const error = query.state.error
      if (isApiError(error) && (error.status === 401 || error.code === 'UNAUTHORIZED')) return false
      const items = query.state.data?.items
      if (!items || items.length === 0) return false
      return items.some((job) => isJobActive(job)) ? JOB_POLL_MS : false
    },
  })
}

/** 单任务详情；进行中时同频轮询，未登录时停止。 */
export function useJob(jobId: string | null | undefined): UseQueryResult<GenerationJobDto> {
  return useQuery({
    queryKey: queryKeys.jobs.detail(jobId ?? ''),
    queryFn: () => clientApi.jobs.detail(jobId as string),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const error = query.state.error
      if (isApiError(error) && (error.status === 401 || error.code === 'UNAUTHORIZED')) return false
      const job = query.state.data
      return job && isJobActive(job) ? JOB_POLL_MS : false
    },
  })
}

/** 202 新建任务后写缓存，结果卡无需等下一轮刷新。 */
export function useSeedCreatedJob() {
  const queryClient = useQueryClient()
  return (job: GenerationJobDto) => cacheCreatedJob(queryClient, job)
}

function useInvalidateJobScopes() {
  const queryClient = useQueryClient()
  return (jobId?: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.root })
    if (jobId) void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.detail(jobId) })
    // 任务终态会写入 assets，图库缓存同步失效。
    void queryClient.invalidateQueries({ queryKey: queryKeys.library.root })
  }
}

export function useCancelJob() {
  const invalidate = useInvalidateJobScopes()
  return useMutation({
    mutationFn: (jobId: string) => clientApi.jobs.cancel(jobId),
    onSuccess: (job) => invalidate(job.id),
  })
}

export function useRetryJob() {
  const invalidate = useInvalidateJobScopes()
  return useMutation({
    mutationFn: (jobId: string) => clientApi.jobs.retry(jobId),
    onSuccess: (job) => invalidate(job.id),
  })
}

export function useDeleteJob() {
  const invalidate = useInvalidateJobScopes()
  return useMutation({
    mutationFn: (jobId: string) => clientApi.jobs.remove(jobId),
    onSuccess: (_result, jobId) => invalidate(jobId),
  })
}
