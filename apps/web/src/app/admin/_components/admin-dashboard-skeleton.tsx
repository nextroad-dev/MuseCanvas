import { Card, Skeleton } from '@/shared/components/ui'

/**
 * 后台概览的加载占位：与 `AdminDashboardView` 几何对齐（页头、4 个 KPI 卡、
 * 近 7 天趋势卡、默认媒体模型卡、最近任务表与 4 个快捷导航卡）。
 */
export function AdminDashboardSkeleton() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">正在加载后台概览…</span>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index} density="none" className="justify-between gap-4 border border-border px-5 py-5">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="size-9 rounded-control" />
            </div>
            <Skeleton className="h-9 w-28" />
          </Card>
        ))}
      </div>

      <Card density="none" className="gap-4 border border-border p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-44" />
        </div>
        <Skeleton className="h-44 w-full" />
      </Card>

      <Card density="none" className="gap-4 border border-border p-6">
        <Skeleton className="h-6 w-36" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </Card>

      <Card density="none" className="gap-4 border border-border p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-8 w-28" />
        </div>
        <div className="divide-y divide-border rounded-card border border-border">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-4 w-14" />
              <Skeleton className="ml-auto h-4 w-28" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
