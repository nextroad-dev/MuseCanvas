import { Card, CardBody, CardHeader, Skeleton, SkeletonText, controlSquare } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'

/**
 * 账户设置页加载骨架：对齐 `AppShell` 侧栏、顶栏与 `--container-workspace` 12 栏卡片栅格，
 * 数据到达前后无版式跳动。
 */
export default function AccountLoading() {
  return (
    <div aria-busy="true" className="flex min-h-dvh bg-canvas text-foreground">
      <span className="sr-only">正在加载账户设置</span>

      <aside
        aria-hidden="true"
        className="hidden h-dvh w-[var(--layout-sidebar)] shrink-0 flex-col gap-3 border-r border-border bg-surface p-3 md:flex"
      >
        <div className="flex h-10 items-center justify-between px-1">
          <Skeleton className="h-5 w-28" />
          <Skeleton className={cn(controlSquare.sm, 'rounded-control')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-[var(--control-md)] w-full rounded-control" />
          <Skeleton className="h-[var(--control-md)] w-full rounded-control" />
        </div>
        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
          <Skeleton className="h-[var(--control-md)] w-full rounded-control" />
          <Skeleton className="h-10 w-full rounded-control" />
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          aria-hidden="true"
          className="flex h-[var(--layout-header)] shrink-0 items-center border-b border-border bg-surface/90 px-4 sm:px-6 md:px-8"
        >
          <Skeleton className="h-5 w-20" />
        </div>

        <main className="mx-auto flex w-full max-w-[var(--container-workspace)] flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:px-8 md:py-8">
          <div className="flex flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-8 w-32" />
            <SkeletonText lines={1} width="22rem" />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12" aria-hidden="true">
            <Card className="lg:col-span-7">
              <CardHeader className="border-b border-border/70 pb-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3.5">
                    <Skeleton className={cn(controlSquare.lg, 'rounded-pill')} />
                    <div className="flex flex-col gap-1.5">
                      <Skeleton className="h-5 w-24" />
                      <Skeleton className="h-4 w-48" />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-5 w-16 rounded-pill" />
                    <Skeleton className="h-5 w-14 rounded-pill" />
                  </div>
                </div>
              </CardHeader>
              <CardBody>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[0, 1, 2, 3].map((slot) => (
                    <div
                      key={slot}
                      className="flex flex-col gap-2 rounded-control border border-border/70 bg-canvas/60 px-3.5 py-3"
                    >
                      <Skeleton className="h-3 w-16" />
                      <Skeleton className="h-4 w-36" />
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>

            <Card className="lg:col-span-5">
              <CardHeader className="border-b border-border/70 pb-4">
                <Skeleton className="h-5 w-32" />
                <SkeletonText lines={1} width="18rem" />
              </CardHeader>
              <CardBody className="gap-3">
                {[0, 1].map((slot) => (
                  <div key={slot} className="flex items-center justify-between gap-3 py-2">
                    <div className="flex items-center gap-3">
                      <Skeleton className={cn(controlSquare.md, 'rounded-control')} />
                      <div className="flex flex-col gap-1.5">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-3.5 w-36" />
                      </div>
                    </div>
                    <Skeleton className="h-[var(--control-sm)] w-20 rounded-control" />
                  </div>
                ))}
              </CardBody>
            </Card>

            <Card className="lg:col-span-12">
              <CardHeader className="border-b border-border/70 pb-4">
                <Skeleton className="h-5 w-28" />
                <SkeletonText lines={1} width="26rem" />
              </CardHeader>
              <CardBody>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-col gap-1.5">
                    <Skeleton className="h-4 w-28" />
                    <SkeletonText lines={1} width="22rem" />
                  </div>
                  <Skeleton className="h-[var(--control-md)] w-32 rounded-control" />
                </div>
              </CardBody>
            </Card>
          </div>
        </main>
      </div>
    </div>
  )
}
