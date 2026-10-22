import { ContentFrame } from '@/shared/components/content-frame'
import { Divider, Skeleton, SkeletonText } from '@/shared/components/ui'

/** Mirrors the account page: header, in-page anchors, then two unboxed sections. */
export default function AccountLoading() {
  return (
    <ContentFrame className="motion-page-enter py-6 md:py-8" aria-busy="true">
      <div className="flex flex-col gap-10">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-48" />
          <SkeletonText lines={1} width="min(28rem, 75vw)" />
        </div>
        <div className="flex w-full max-w-[var(--content-narrow)] flex-col gap-8">
          <div className="flex gap-2" aria-hidden="true">
            <Skeleton className="h-10 w-24" /><Skeleton className="h-10 w-24" />
          </div>
          <div className="flex flex-col gap-10">
            <section className="flex flex-col gap-6" aria-hidden="true">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-6 w-24" />
                <SkeletonText lines={1} width="64%" />
              </div>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                {[0, 1, 2].map((slot) => (
                  <div key={slot} className={`flex flex-col gap-2 ${slot === 0 ? 'sm:col-span-2' : ''}`}>
                    <Skeleton className="h-4 w-20" /><Skeleton className="h-5 w-36" />
                  </div>
                ))}
              </div>
            </section>
            <Divider />
            <section className="flex flex-col gap-3" aria-hidden="true">
              <div className="flex flex-col gap-2">
                <Skeleton className="h-6 w-24" />
                <SkeletonText lines={2} width="90%" />
              </div>
              {[0, 1].map((slot) => (
                <div key={slot} className="flex flex-wrap items-center justify-between gap-3 rounded-panel bg-tonal p-4">
                  <div className="flex flex-col gap-2"><Skeleton className="h-5 w-24" /><Skeleton className="h-4 w-36" /></div>
                  <Skeleton className="h-[var(--control-md)] w-24" />
                </div>
              ))}
            </section>
          </div>
        </div>
        <p className="sr-only">正在加载账户与安全…</p>
      </div>
    </ContentFrame>
  )
}
