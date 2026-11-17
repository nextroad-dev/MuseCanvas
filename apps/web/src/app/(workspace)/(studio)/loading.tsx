import { Skeleton, SkeletonRow } from '@/shared/components/ui'

export default function StudioLoading() {
  return (
    <div
      role="status"
      aria-label="正在加载工作区"
      className="flex min-h-0 min-w-0 flex-1 bg-canvas"
    >
      <aside className="hidden w-64 shrink-0 flex-col gap-3 border-r border-border/70 bg-surface/60 p-4 md:flex lg:w-72">
        <Skeleton className="h-8 w-28" />
        <SkeletonRow cells={1} />
        <SkeletonRow cells={1} />
        <SkeletonRow cells={1} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/40 bg-canvas/85 px-3 sm:px-5">
          <Skeleton className="h-5 w-24 rounded-control" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-7 w-16 rounded-pill" />
            <Skeleton className="h-7 w-20 rounded-pill" />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-between px-4 pb-4 pt-6 sm:px-6 sm:pb-6">
          <div className="mx-auto w-full max-w-3xl space-y-4">
            <Skeleton className="ml-auto h-14 w-2/3 rounded-panel" />
            <Skeleton className="h-28 w-5/6 rounded-card" />
            <Skeleton className="h-20 w-3/4 rounded-card" />
          </div>
          <div className="mx-auto mt-6 w-full max-w-3xl">
            <Skeleton className="h-24 w-full rounded-panel" />
          </div>
        </div>
      </div>
      <span className="sr-only">正在加载工作区</span>
    </div>
  )
}
