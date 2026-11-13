import { Card, Skeleton } from '@/shared/components/ui'

/**
 * 后台概览的加载占位：几何尽量贴近真实内容（标题、两个指标卡、趋势卡、
 * 默认模型条、最近任务表），避免数据到位时整页跳动。
 */
export function AdminDashboardSkeleton() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-7">
      <span className="sr-only">正在加载后台概览…</span>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-4 w-24" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
        {[0, 1].map((index) => (
          <Card key={index} density="none" className="justify-between gap-3 px-6 py-5">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-11 w-28" />
          </Card>
        ))}
        <Card
          density="none"
          className="gap-4 px-6 py-5 sm:col-span-2 lg:col-span-1"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-[150px] w-full" />
        </Card>
      </div>

      <Card density="none" className="flex-row flex-wrap items-center gap-8 px-6 py-5">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="ml-auto h-8 w-20" />
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-28" />
        </div>
        <Card density="none" className="overflow-hidden">
          <div className="divide-y divide-border">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex items-center gap-4 px-5 py-3">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-10" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-5 w-16" />
                <Skeleton className="ml-auto h-4 w-28" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
