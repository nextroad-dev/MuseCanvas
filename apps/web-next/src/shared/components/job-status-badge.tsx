'use client'

import { Loader2 } from 'lucide-react'
import { jobStatusMeta } from '@/shared/lib/job-status'
import type { JobStatus } from '@/shared/types'

export function JobStatusBadge({ status, busy = false }: { status: JobStatus; busy?: boolean }) {
  const meta = jobStatusMeta(status)

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-pill)] px-2 py-0.5 text-xs font-medium ${meta.badge}`}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      ) : (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-[var(--radius-pill)] ${meta.dot}`} aria-hidden="true" />
      )}
      {meta.label}
    </span>
  )
}
