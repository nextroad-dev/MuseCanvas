// 新建任务后立刻写进任务列表缓存，避免 202 返回后结果卡要等下一轮轮询才出现。
// 只操作「jobs」根 key 下的列表缓存；详情缓存单独 seed，供结果卡直读。

import type { QueryClient } from '@tanstack/react-query'
import type { GenerationJobDto, GenerationJobListDto, JobFilters } from '@/shared/types'
import { isJobActive } from './job-status'
import { queryKeys } from '../hooks/query-keys'

export function prependCreatedJob(
  previous: GenerationJobDto[] | undefined,
  job: GenerationJobDto,
  limit?: number,
): GenerationJobDto[] {
  const items = [job, ...(previous ?? []).filter((entry) => entry.id !== job.id)]
  return limit ? items.slice(0, limit) : items
}

const isJobsListKey = (key: readonly unknown[]): boolean => key[0] === 'jobs' && key[1] === 'list'

/** 先取消旧列表请求再写入，防止仍在飞行的响应把新任务覆盖掉。 */
export async function cacheCreatedJob(queryClient: QueryClient, job: GenerationJobDto): Promise<void> {
  // 初次加载没有可替换的数据，必须让请求完成；取消会把已挂载列表留在 pending/idle。
  await queryClient.cancelQueries({
    predicate: (query) => isJobsListKey(query.queryKey) && query.state.data !== undefined,
  })
  for (const [key, previous] of queryClient.getQueriesData<GenerationJobListDto>({
    predicate: (query) => isJobsListKey(query.queryKey),
  })) {
    if (!previous || !Array.isArray(previous.items)) continue
    const filters = key[2] as JobFilters | null | undefined
    const matches = !filters?.status || (filters.status === 'active'
      ? isJobActive(job)
      : job.status === filters.status)
    if (!matches) continue
    // total/hasMore 是服务端窗口的快照，不是客户端筛选后的 items 数量。
    queryClient.setQueryData(key, {
      ...previous,
      items: prependCreatedJob(previous.items, job, Math.min(filters?.limit || 50, 50)),
    })
  }
  // 结果卡按 id 读详情：先 seed，任务详情查询随后会用服务端数据校正。
  queryClient.setQueryData(queryKeys.jobs.detail(job.id), job)
}
