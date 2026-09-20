'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import type { GenerationJob } from '@/shared/types'
import { LIBRARY_QUERY_KEY } from './useLibrary'
import { CREDITS_QUERY_KEY } from './useAccount'

export const JOBS_QUERY_KEY = ['jobs'] as const

export function useJobsQuery(limit?: number) {
  return useQuery({
    queryKey: limit ? [...JOBS_QUERY_KEY, limit] : JOBS_QUERY_KEY,
    queryFn: async () => {
      const res = await api.getJobs()
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || '获取任务列表失败')
      }
      const items = (res.data.items || []) as GenerationJob[]
      return limit ? items.slice(0, limit) : items
    },
    refetchInterval: (query) => {
      const jobs = query.state.data
      if (!jobs || jobs.length === 0) return false
      const hasActive = jobs.some(
        (j) => j.status === 'queued' || j.status === 'running' || j.status === 'retry_wait',
      )
      return hasActive ? 2500 : false
    },
  })
}

export function useCreateJobMutation() {

  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await api.createGeneration(payload)
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || '创建生成任务失败')
      }
      return res.data as GenerationJob
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: CREDITS_QUERY_KEY })
    },
  })
}

export function useCancelJobMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (jobId: string) => {
      const res = await api.cancelJob(jobId)
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || '取消任务失败')
      }
      return res.data as GenerationJob
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: CREDITS_QUERY_KEY })
    },
  })
}

export function useRetryJobMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (jobId: string) => {
      const res = await api.retryJob(jobId)
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || '重试任务失败')
      }
      return res.data as GenerationJob
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: CREDITS_QUERY_KEY })
    },
  })
}

export function useDeleteJobMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (jobId: string) => {
      const res = await api.deleteJob(jobId)
      if (!res.success) {
        throw new Error(res.error?.message || '删除任务失败')
      }
      return jobId
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY })
    },
  })
}

export const useCreateJob = useCreateJobMutation
export const useCancelJob = useCancelJobMutation
export const useRetryJob = useRetryJobMutation
export const useDeleteJob = useDeleteJobMutation

