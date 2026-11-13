import { Card, CardBody, CardHeader, Skeleton, SkeletonText } from '@/shared/components/ui'

/**
 * 账户页加载骨架：页头 + 两张卡片的形状，和 `AccountView` 的版式一一对应，
 * 页面数据到达前后不产生布局跳动。
 */
export default function AccountLoading() {
  return (
    <div aria-busy="true" className="mx-auto flex w-full max-w-[var(--container-content)] flex-col gap-8 px-4 py-8 md:px-8">
      <span className="sr-only">正在加载账户信息</span>
      <div className="flex flex-wrap items-end justify-between gap-3" aria-hidden="true">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-24" />
          <SkeletonText lines={1} width="18rem" />
        </div>
        <Skeleton className="h-[var(--control-md)] w-28 rounded-control" />
      </div>

      <div className="flex w-full max-w-[var(--content-narrow)] flex-col gap-6">
        {[0, 1].map((slot) => (
          <Card key={slot}>
            <CardHeader>
              <Skeleton className="h-5 w-28" />
              <SkeletonText lines={1} width="22rem" />
            </CardHeader>
            <CardBody>
              {slot === 0 ? (
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2" aria-hidden="true">
                  <div className="flex flex-col gap-2 sm:col-span-2">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-4 w-64" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-5 w-20 rounded-pill" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-4 w-36" />
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3" aria-hidden="true">
                  <Skeleton className="h-16 w-full rounded-control" />
                  <Skeleton className="h-16 w-full rounded-control" />
                </div>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  )
}
