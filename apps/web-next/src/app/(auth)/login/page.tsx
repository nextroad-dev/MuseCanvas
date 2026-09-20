import { redirect } from 'next/navigation'
import { serverApi } from '@/shared/services/server-api'
import { LoginForm } from '@/features/auth/components/login-form'
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

  // Check if already authenticated via server-side session
  const meRes = await serverApi.getMe()
  if (meRes.success && meRes.data) {
    redirect(from || '/generate')
  }

  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-muted-foreground">正在加载...</div>}>
      <LoginForm />
    </Suspense>
  )
}
