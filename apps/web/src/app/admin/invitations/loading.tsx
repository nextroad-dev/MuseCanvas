import { Card, Skeleton } from '@/shared/components/ui'

export default function AdminInvitationsLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">正在加载邀请码管理…</span>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>

      <Card density="none" className="gap-4 border border-border p-6">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-16 w-full" />
      </Card>

      <Card density="none" className="overflow-hidden border border-border">
        <div className="divide-y divide-border">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="ml-auto h-8 w-20" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
