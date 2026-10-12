import { ContentFrame } from '@/shared/components/content-frame'
import { Skeleton } from '@/shared/components/ui'

/** Matches the creation console: header, rail + timeline split, floating composer. */
export default function GenerateLoading() {
  return (
    <ContentFrame role="region" aria-label="创作台" aria-busy="true" className="motion-page-enter flex h-full min-h-0 flex-1 flex-col gap-6 py-6 md:py-8">
      <div aria-hidden="true" className="flex shrink-0 flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-5 w-64 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-[var(--control-sm)] w-28" />
          <Skeleton className="h-[var(--control-sm)] w-24" />
        </div>
      </div>
      <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row lg:gap-0">
        <div className="hidden w-[var(--container-settings-nav)] shrink-0 flex-col gap-3 border-r border-border pr-6 lg:flex">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 lg:pl-6">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="min-h-[40vh] w-full flex-1 rounded-panel" />
          <Skeleton className="h-[var(--control-md)] w-full rounded-panel" />
        </div>
      </div>
      <div aria-hidden="true" className="flex shrink-0 flex-col gap-3 rounded-panel bg-surface p-3 shadow-floating md:p-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-[var(--control-sm)] w-24" />
        </div>
        <div className="hidden flex-col gap-3 md:flex">
          <Skeleton className="h-[var(--control-sm)] w-44" />
          <Skeleton className="h-16 w-full" />
        </div>
        <Skeleton className="ml-auto h-[var(--control-md)] w-28" />
      </div>
      <span className="sr-only">正在载入创作台</span>
    </ContentFrame>
  )
}
