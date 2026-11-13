import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { AccountView } from '@/features/account/components/account-view'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { getAccount } from '@/shared/services/server-api'

/**
 * 账户页：RSC 守卫 + 首屏数据。
 *
 * 未登录（或会话已失效）在服务端直接 redirect 到 `/login?next=/account`，
 * 登录后回到本页；已登录则把会话 + 第三方绑定一次性交给客户端岛，
 * 首帧不需要骨架屏。OAuth 回跳的 `?linked=1` / `?error=CODE` 交给客户端提示。
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '账户',
  description: '查看 MuseCanvas 账户信息，管理第三方登录方式。',
}

type AccountSearchParams = Promise<Record<string, string | string[] | undefined>>

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export default async function AccountPage({ searchParams }: { searchParams: AccountSearchParams }) {
  const [account, params] = await Promise.all([getAccount(), searchParams])

  if (!account) {
    redirect(`${APP_ROUTES.login}?next=${encodeURIComponent(APP_ROUTES.account)}`)
  }

  return (
    <AccountView
      initialAccount={account}
      callback={{ linked: firstValue(params.linked), error: firstValue(params.error) }}
    />
  )
}
