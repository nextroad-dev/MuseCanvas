import { Card, Skeleton, SkeletonText } from '@/shared/components/ui'

/**
 * 安装向导的路由级加载骨架：单列居中白卡 + 步数提示 + 表单 + 底部导航栏，
 * 几何与真实向导一致，首屏数据到达前后不产生布局跳动。
 */
export default function SetupLoading() {
  return (
    <div aria-busy="true" className="flex w-full flex-col">
      <span className="sr-only">正在加载安装向导</span>

      <Card variant="surface" density="none" aria-hidden="true">
        <div className="flex flex-col gap-2 border-b border-border/70 px-5 pb-4 pt-5 sm:px-6 sm:pb-5 sm:pt-6">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-5 w-16 rounded-pill" />
          </div>
          <Skeleton className="h-7 w-40" />
          <SkeletonText lines={1} width="24rem" />
        </div>

        <div className="flex flex-col gap-5 px-5 py-5 sm:px-6 sm:py-6">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Skeleton className="h-[var(--control-md)] rounded-control" />
            <Skeleton className="h-[var(--control-md)] rounded-control" />
          </div>
          <Skeleton className="h-[var(--control-md)] rounded-control" />
          <Skeleton className="h-[var(--control-md)] w-32 rounded-control" />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/70 px-5 py-4 sm:px-6">
          <Skeleton className="h-[var(--control-md)] w-24 rounded-control" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-[var(--control-md)] w-24 rounded-control" />
        </div>
      </Card>
    </div>
  )
}
