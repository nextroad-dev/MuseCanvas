import { Card, Skeleton } from '@/shared/components/ui'

/** OAuth 页加载占位：标题 + 提示栏 + 两张提供商卡，几何贴近真实内容。 */
export default function AdminOAuthLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <span className="sr-only">正在加载 OAuth 配置…</span>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-16 w-full" />
      <div className="grid gap-4 xl:grid-cols-2">
        {[0, 1].map((index) => (
          <Card key={index}>
            <Skeleton className="h-6 w-36" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <div className="flex justify-between pt-2">
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-9 w-28" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
