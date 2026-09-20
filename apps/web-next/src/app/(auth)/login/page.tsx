import { redirect } from 'next/navigation'
import { serverApi } from '@/shared/services/server-api'
import { LoginForm } from '@/features/auth/components/login-form'
import { ServiceUnavailable } from '@/shared/components/service-unavailable'
import { Suspense } from 'react'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '登录 - MuseCanvas',
  description: '登录 MuseCanvas AI 创作工作台',
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
    redirect(from || '/generate')
  }
  if (sessionRes.error?.code === 'UPSTREAM_UNAVAILABLE') {
    return <ServiceUnavailable />
  }

  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-muted-foreground">正在加载...</div>}>
      <LoginForm />
    </Suspense>
  )
}
