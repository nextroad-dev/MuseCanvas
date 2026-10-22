import { PageHeader, Skeleton, SkeletonRow, SkeletonText } from '@/shared/components/ui'
import { ContentFrame } from '@/shared/components/content-frame'

/** Mirrors the wizard's geometry: header, stepper band, page header and one step body. */
export function SetupWizardSkeleton() {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-foreground" role="status" aria-busy="true">
      <span className="sr-only">正在读取系统配置状态</span>
      <header className="border-b border-border bg-surface" aria-hidden="true">
        <ContentFrame className="flex h-[var(--layout-header)] items-center justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-6 w-24 rounded-pill" />
          </div>
        </ContentFrame>
      </header>
      <div className="shrink-0 bg-tonal py-6 sm:py-8" aria-hidden="true">
        <ContentFrame>
          {/* The step count depends on `claimRequired`, which is unknown until status loads. The track
              therefore reserves the band's height without drawing a number of steps. */}
          <Skeleton className="h-14 w-full" />
        </ContentFrame>
      </div>
      <main className="flex flex-1 justify-center py-10 sm:py-14" aria-hidden="true">
        <ContentFrame className="flex justify-center">
          <div className="flex w-full max-w-form flex-col gap-8">
            <PageHeader
              aria-hidden="true"
              title={<span className="invisible">系统初始化</span>}
              description={<span className="invisible">按顺序完成各项初始化配置。</span>}
            />
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2 border-b border-border pb-6">
                <Skeleton className="h-6 w-40" />
                <SkeletonText lines={1} />
              </div>
              <div className="flex flex-col gap-3 rounded-control bg-tonal p-4">
                <SkeletonRow />
                <SkeletonRow />
              </div>
              <Skeleton className="h-[var(--control-md)] w-28 rounded-control" />
            </div>
          </div>
        </ContentFrame>
      </main>
    </div>
  )
}
