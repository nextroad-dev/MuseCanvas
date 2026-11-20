import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { AccountView } from '@/features/account/components/account-view'
import { AppShell } from '@/shared/components/shells'
import { APP_ROUTES, loginHref } from '@/shared/lib/app-routes'
import { WORKSPACE_MODE } from '@/shared/lib/workspace-mode'
import { MOCK_ACCOUNT } from '@/shared/services/mock-identity'
import { getAccount } from '@/shared/services/server-api'

/**
 * 账户设置页：RSC 守卫 + 首屏数据。
 *
 * 未登录（或会话已失效）在服务端直接 redirect 到 `/login?next=/account`，
 * 登录后回到本页；已登录则把会话 + 第三方绑定一次性交给客户端岛，
 * 首帧不需要骨架屏。OAuth 回跳的 `?linked=1` / `?error=CODE` 交给客户端提示。
 * `/account` 始终为真实会话鉴权，不使用 mock 预览模式。
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '账户设置',
  description: '管理登录身份、第三方账号关联与当前会话安全。',
}

type AccountSearchParams = Promise<Record<string, string | string[] | undefined>>

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export default async function AccountPage({ searchParams }: { searchParams: AccountSearchParams }) {
  const params = await searchParams
  // 本地演示：使用 mock 账户身份；live 模式仍要求真实会话。
  const account = WORKSPACE_MODE === 'mock' ? MOCK_ACCOUNT : await getAccount()

  if (!account) {
    redirect(loginHref(APP_ROUTES.account))
  }

  return (
    <AppShell mode={WORKSPACE_MODE} user={account.user} headerTitle="账户设置">
      <AccountView
        initialAccount={account}
        callback={{ linked: firstValue(params.linked), error: firstValue(params.error) }}
      />
    </AppShell>
  )
}
