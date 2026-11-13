'use client'

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useJobs } from '@/shared/hooks/useJobs'
import { queryKeys } from '@/shared/hooks/query-keys'

/** Keep task polling alive across studio navigation, including an open library. */
export function WorkspaceJobObserver() {
  const jobs = useJobs()
  const queryClient = useQueryClient()
  const previous = useRef(new Map<string, string>())

  useEffect(() => {
    if (!jobs.data) return
    const current = new Map<string, string>()
    let changed = false
    for (const job of jobs.data.items) {
      const identity = `${job.status}:${job.outputs.map((output) => output.assetId).join(',')}`
      current.set(job.id, identity)
      if ((job.status === 'succeeded' || job.outputs.length > 0) && previous.current.get(job.id) !== identity) changed = true
    }
    previous.current = current
    if (changed) void queryClient.invalidateQueries({ queryKey: queryKeys.library.root })
  }, [jobs.data, queryClient])

  return null
}
