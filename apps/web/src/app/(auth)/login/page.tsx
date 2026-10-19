import { redirect } from 'next/navigation'
import { serverApi } from '@/shared/services/server-api'
import { LoginForm } from '@/features/auth/components/login-form'
import { ServiceUnavailable } from '@/shared/components/service-unavailable'
import { safeRedirectPath } from '@/shared/lib/app-routes'
import { Skeleton, SkeletonText } from '@/shared/components/ui/skeleton'
import { Suspense } from 'react'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '登录 - MuseCanvas',
  description: '登录 MuseCanvas AI 创作工作台',
}

/** Shape-matched placeholder for the client form and its OAuth alternatives. */
function LoginFormFallback() {
  return (
    <div aria-busy="true" className="flex flex-col gap-8">
      <span className="sr-only">正在加载登录表单</span>
      <header className="flex flex-col items-start gap-3" aria-hidden="true">
        <Skeleton className="h-8 w-48" />
        <SkeletonText lines={1} width="16rem" />
      </header>
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

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>
}) {
  const { from } = await searchParams

  // Server-side session pre-check: authenticated users redirect; a downed
  // backend must not render a form whose submit is guaranteed to fail.
  const sessionRes = await serverApi.getMe()
  if (sessionRes.success && sessionRes.data?.user) {
    redirect(safeRedirectPath(from))
  }
  if (sessionRes.error?.code === 'UPSTREAM_UNAVAILABLE') {
    return <ServiceUnavailable mode="inline" />
  }

  return (
    <Suspense fallback={<LoginFormFallback />}>
      <LoginForm />
    </Suspense>
  )
}
