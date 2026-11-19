import { Card, Skeleton } from '@/shared/components/ui'

/** `/admin/plugins` 路由段加载态占位。 */
export default function AdminPluginsLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">正在加载插件管理…</span>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>

      <Card density="none" className="overflow-hidden">
        <div className="divide-y divide-border">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex items-center gap-4 px-4 py-4">
              <Skeleton className="size-9 rounded-control" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-5 w-44" />
                <Skeleton className="h-4 w-64" />
              </div>
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="ml-auto h-8 w-36" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
