'use client'

import type { ReactNode } from 'react'
import { Alert, CardDescription, CardTitle } from '@/shared/components/ui'

export interface StepNoticeState {
  tone: 'success' | 'danger'
  text: string
}

/** Result of the last action in a step. Failures are assertive, successes polite. */
export function StepNotice({ notice }: { notice: StepNoticeState | null }) {
  if (!notice) return null
  return (
    <Alert tone={notice.tone} role={notice.tone === 'danger' ? 'alert' : 'status'}>
      {notice.text}
    </Alert>
  )
}

/**
 * Chrome shared by every wizard step: title, one-sentence purpose and an optional
 * status on the right. The `<section>` is labelled by its heading and owns the
 * `@container/fields` context the shared settings forms lay out against.
 */
export function StepFrame({
  headingId,
  title,
  description,
  status,
  children,
}: {
  headingId: string
  title: string
  description: string
  status?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={headingId} className="@container/fields flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border pb-6">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle level={2} id={headingId}>
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {status ? <div className="flex shrink-0 items-center gap-2">{status}</div> : null}
      </header>
      {children}
    </section>
  )
}
