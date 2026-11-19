import { Card, Skeleton } from '@/shared/components/ui'

export default function AdminUsersLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">正在加载用户管理…</span>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-20" />
      </div>

      <Card density="none" className="flex flex-wrap items-center justify-between gap-3 border border-border p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-48" />
        </div>
        <Skeleton className="h-6 w-24" />
      </Card>

      <Card density="none" className="overflow-hidden border border-border">
        <div className="divide-y divide-border">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="size-8 rounded-pill" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="ml-auto h-8 w-28" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
