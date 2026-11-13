import { Skeleton, SkeletonText } from '@/shared/components/ui'

/**
 * 安装向导的路由级加载骨架：步骤条色带 + 标题 + 白卡表单，几何与真实向导一致，
 * 首屏数据到达前后不产生布局跳动。
 */
export default function SetupLoading() {
  return (
    <div aria-busy="true" className="flex flex-1 flex-col">
      <span className="sr-only">正在加载安装向导</span>

      <div className="bg-tonal py-6 md:py-8" aria-hidden="true">
        <div className="mx-auto w-full max-w-[var(--container-content)] px-4 md:px-8">
          <Skeleton className="h-10 w-full rounded-control" />
        </div>
      </div>

      <main className="flex flex-1 justify-center px-4 py-8 md:px-8 md:py-12">
        <div className="flex w-full max-w-[var(--container-form)] flex-col gap-6">
          <div className="flex flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-8 w-40" />
            <SkeletonText lines={1} width="22rem" />
          </div>

          <div className="rounded-panel bg-surface p-6 shadow-soft md:p-8" aria-hidden="true">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-32" />
                <SkeletonText lines={1} width="24rem" />
              </div>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Skeleton className="h-[var(--control-md)] rounded-control" />
                <Skeleton className="h-[var(--control-md)] rounded-control" />
              </div>
              <Skeleton className="h-[var(--control-md)] w-32 rounded-control" />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3" aria-hidden="true">
            <Skeleton className="h-[var(--control-md)] w-24 rounded-control" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-[var(--control-md)] w-24 rounded-control" />
          </div>
        </div>
      </main>
    </div>
  )
}
