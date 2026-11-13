import { Skeleton, SkeletonText } from '@/shared/components/ui'

/**
 * 登录页加载骨架：只占位表单本身的形状（标题 / 邮箱 / 主按钮 / 第三方行 / 协议），
 * 外框与右列拼图来自 `(auth)/layout.tsx`，不在这里重复。
 */
export default function LoginLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-7">
      <span className="sr-only">正在加载登录页面</span>
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-8 w-52" />
        <SkeletonText lines={1} width="10rem" />
      </div>
      <div className="flex flex-col gap-4" aria-hidden="true">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-[var(--control-lg)] w-full rounded-control" />
        </div>
        <Skeleton className="h-[var(--control-lg)] w-full rounded-control" />
      </div>
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-px w-full rounded-none" />
        <div className="grid grid-cols-2 gap-2.5">
          <Skeleton className="h-[var(--control-touch)] rounded-control" />
          <Skeleton className="h-[var(--control-touch)] rounded-control" />
        </div>
      </div>
      <Skeleton className="mx-auto h-3 w-56" />
    </div>
  )
}
