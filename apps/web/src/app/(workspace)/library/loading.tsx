import { ContentFrame } from '@/shared/components/content-frame'
import { Skeleton, SkeletonText, SkeletonTile } from '@/shared/components/ui'

/** Mirrors the library: header, a flat toolbar over a divider, the type tabs, then the grid. */
export default function LibraryLoading() {
  return (
    <ContentFrame className="motion-page-enter flex flex-col gap-8 py-6 md:py-8" aria-busy="true">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-10 w-40" />
          <SkeletonText lines={1} width="min(32rem, 75vw)" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-[var(--control-sm)] w-16" />
          <Skeleton className="h-[var(--control-sm)] w-24" />
        </div>
      </div>
      <div className="flex flex-col gap-4 border-b border-border pb-6" aria-hidden="true">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <Skeleton className="h-[var(--control-md)] w-full sm:flex-1 md:max-w-form" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-[var(--control-md)] w-full sm:w-36" />
          </div>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-52" />
        </div>
      </div>
      <div className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((tab) => <Skeleton key={tab} className="h-10 w-20 rounded-control" />)}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="overflow-hidden rounded-card bg-surface">
            <SkeletonTile />
            <div className="flex flex-col gap-3 p-3">
              <Skeleton className="h-10 w-full" />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Skeleton className="h-4 w-20" /><Skeleton className="h-10 w-32" />
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="sr-only">正在加载作品图库…</p>
    </ContentFrame>
  )
}
