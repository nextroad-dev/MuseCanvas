'use client'

import { CircleNotchIcon as Loader2 } from '@phosphor-icons/react'
import { jobStatusMeta } from '@/shared/lib/job-status'
import { cn } from '@/shared/lib/cn'
import type { JobStatus } from '@/shared/types'

/**
 * Job state as text + colour, never colour alone: the label is always present, the
 * dot is decoration (`aria-hidden`) and the spinner only replaces it while an
 * action is in flight. Pill geometry (`--radius-pill`, 12px/500) on the weak
 * semantic background with the matching strong foreground, which is what keeps the
 * caption legible in both themes — the brand green of `running` stays a status
 * graphic, never a solid fill.
 */
export function JobStatusBadge({ status, busy = false }: { status: JobStatus; busy?: boolean }) {
  const meta = jobStatusMeta(status)

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill px-2 py-0.5 text-xs font-medium',
        meta.badge,
      )}
    >
      {busy ? (
        <Loader2 weight="bold" className="h-3 w-3 motion-spin" aria-hidden="true" />
      ) : (
        <span className={cn('h-2 w-2 shrink-0 rounded-pill', meta.dot)} aria-hidden="true" />
      )}
      {meta.label}
    </span>
  )
}
