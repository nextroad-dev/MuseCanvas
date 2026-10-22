import { Skeleton, SkeletonText } from '@/shared/components/ui'

/**
 * Sits inside the `(auth)` panel, so it only reserves the form shape: heading,
 * field, submit and the OAuth row. The panel's own entrance is already on the layout.
 */
export default function LoginLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-8">
      <span className="sr-only">正在加载登录页面</span>
      <div className="flex flex-col items-start gap-3" aria-hidden="true">
        <Skeleton className="h-8 w-48" />
        <SkeletonText lines={1} width="16rem" />
      </div>
      <div className="flex flex-col gap-6" aria-hidden="true">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-[var(--control-lg)] w-full rounded-control" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-[var(--control-lg)] w-full rounded-control" />
      </div>
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-px w-full rounded-none" />
        <div className="flex flex-col gap-3 sm:flex-row">
          <Skeleton className="h-[var(--control-lg)] flex-1 rounded-control" />
          <Skeleton className="h-[var(--control-lg)] flex-1 rounded-control" />
        </div>
      </div>
    </div>
  )
}
