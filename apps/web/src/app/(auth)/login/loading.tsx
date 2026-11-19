import { Card, Skeleton, SkeletonText } from '@/shared/components/ui'

/**
 * 登录页加载骨架：与 `LoginForm` 共用相同的 `Card` 容器与高度节奏，
 * 避免水合前后发生布局跳动。外框与右栏作品示例来自 `(auth)/layout.tsx`。
 */
export default function LoginLoading() {
  return (
    <Card density="none" aria-busy="true" className="w-full gap-6 p-6 sm:p-8">
      <span className="sr-only">正在加载登录页面</span>

      <div className="flex flex-col gap-2.5" aria-hidden="true">
        <Skeleton className="h-5 w-28 rounded-pill" />
        <Skeleton className="h-8 w-48" />
        <SkeletonText lines={1} width="14rem" />
      </div>

      <div className="flex flex-col gap-4" aria-hidden="true">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-[var(--control-lg)] w-full rounded-control" />
        </div>
        <Skeleton className="h-[var(--control-lg)] w-full rounded-control" />
      </div>

      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-px w-full rounded-none" />
        <div className="grid grid-cols-2 gap-2.5">
          <Skeleton className="h-[var(--control-lg)] rounded-control" />
          <Skeleton className="h-[var(--control-lg)] rounded-control" />
        </div>
      </div>

      <Skeleton className="mx-auto h-3.5 w-52" />
    </Card>
  )
}
