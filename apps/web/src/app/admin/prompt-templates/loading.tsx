import { Card, Skeleton } from '@/shared/components/ui'

/** 提示词模板页加载占位：标题 + 集列表 + 条目表 + 两张设置卡。 */
export default function AdminPromptTemplatesLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">正在加载提示词模板…</span>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Skeleton className="h-9 w-40" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
      {[0, 1].map((index) => (
        <Card key={index} density="none" className="gap-4 p-6">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </Card>
      ))}
      <div className="grid gap-4 xl:grid-cols-2">
        {[0, 1].map((index) => (
          <Card key={index} density="none" className="gap-4 p-6">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </Card>
        ))}
      </div>
    </div>
  )
}
