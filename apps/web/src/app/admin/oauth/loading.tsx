import { Card, Skeleton } from '@/shared/components/ui'

/** OAuth 页加载占位：标题 + 两张提供商卡，几何贴近真实内容。 */
export default function AdminOAuthLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">正在加载 OAuth 配置…</span>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-16 w-full" />
      <div className="grid gap-4 xl:grid-cols-2">
        {[0, 1].map((index) => (
          <Card key={index} density="none" className="gap-4 p-6">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <div className="flex justify-end">
              <Skeleton className="h-9 w-28" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
