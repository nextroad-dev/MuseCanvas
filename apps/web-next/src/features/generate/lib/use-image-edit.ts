'use client'

// The 局部修改 submit path, shaped exactly like `useCreateJobMutation`: same
// invalidations, same "a job row is the result" contract. An edit produces a new
// job rather than touching the source, so the rail, the stage and the library all
// update through the machinery that already polls for generation jobs.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/shared/services/client-api'
import { LIBRARY_QUERY_KEY } from '@/shared/hooks/useLibrary'
import { JOBS_QUERY_KEY } from '@/shared/hooks/useJobs'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import type { GenerationJob } from '@/shared/types'
import { postImageEdit } from './edit-image-api'
import type { ImageEditRequest } from './edit-image-api'

export function useCreateImageEdit() {
  const queryClient = useQueryClient()

  return useMutation<GenerationJob, Error, ImageEditRequest>({
    mutationFn: async (request) => {
      const res = await postImageEdit(request)
      if (!res.success || !res.data) {
        throw new ApiError(res.error?.code || 'UNKNOWN', res.error?.message || '创建局部修改任务失败')
      }
      return res.data
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY })
      // Switch to the new job and leave edit mode in the same tick, so the stage
      // shows the queued edit instead of a picture that is no longer the subject
      // of anything. Deliberately success-only: a failed edit keeps the image, the
      // selection and the prompt so the user can fix the words and resubmit.
      const store = useGenerateUiStore.getState()
      store.setSelectedJobId(job.id)
      store.setEditTarget(null)
    },
  })
}
