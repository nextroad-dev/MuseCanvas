import { Card, Skeleton } from '@/shared/components/ui'

/** 系统配置页加载占位：标题 + 状态卡 + 分区表单。 */
export default function AdminSettingsLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">正在加载系统配置…</span>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-24" />
      </div>
      <Card density="none" className="gap-4 p-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </Card>
      <Skeleton className="h-10 w-80" />
      {[0, 1].map((index) => (
        <Card key={index} density="none" className="gap-4 p-6">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <div className="flex justify-end">
            <Skeleton className="h-9 w-28" />
          </div>
        </Card>
      ))}
    </div>
  )
}
