import { Skeleton, SkeletonTile } from '@/shared/components/ui'

export default function StudioLoading() {
  return (
    <div role="status" aria-label="正在加载工作区" className="space-y-6">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="w-3/4 max-w-80" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => <SkeletonTile key={index} />)}
      </div>
      <span className="sr-only">正在加载工作区</span>
    </div>
  )
}
