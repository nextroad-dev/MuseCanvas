import { Skeleton, SkeletonRow } from '@/shared/components/ui'

export default function StudioLoading() {
  return (
    <div
      role="status"
      aria-label="正在加载工作区"
      className="flex min-h-0 min-w-0 flex-1 bg-canvas"
    >
      <div className="flex min-h-0 flex-1 flex-col justify-between px-4 py-8 sm:px-6 lg:px-10">
        <div className="mx-auto w-full max-w-[var(--container-workspace)] space-y-4">
          <Skeleton className="h-8 w-44 rounded-control" />
          <SkeletonRow cells={1} />
          <Skeleton className="h-28 w-full rounded-card" />
          <Skeleton className="h-24 w-4/5 rounded-card" />
        </div>
        <div className="mx-auto mt-6 w-full max-w-3xl">
          <Skeleton className="h-24 w-full rounded-panel" />
        </div>
      </div>
      <span className="sr-only">正在加载工作区</span>
    </div>
  )
}
