import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'

import { AdminShell } from '@/shared/components/shells'
import { APP_ROUTES, loginHref } from '@/shared/lib/app-routes'
import { WORKSPACE_MODE } from '@/shared/lib/workspace-mode'
import { MOCK_SESSION_USER } from '@/shared/services/mock-identity'
import { getSessionUser } from '@/shared/services/server-api'

/**
 * 后台统一门禁（RSC）：`/admin/**` 全部继承这一层。
 *
 * · 未登录 / 会话失效 → `/login?next=/admin`；
 * · 已登录但非管理员 → 跳回创作台（或首页）；
 * · 后端不可用时 `getSessionUser` 抛错，交给 `error.tsx`，不伪装成未登录。
 *
 * 读 Cookie 决定了本段必须动态渲染，显式声明避免被误当作静态段。
 */
export const dynamic = 'force-dynamic'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  // 本地演示：后台使用 mock 管理员身份，避免真实会话依赖；live 模式仍走 RSC 守卫。
  const user = WORKSPACE_MODE === 'mock' ? MOCK_SESSION_USER : await getSessionUser()

  if (!user) {
    redirect(loginHref(APP_ROUTES.admin))
  }
  if (user.role !== 'admin') {
    redirect(APP_ROUTES.generate)
  }

  return <AdminShell user={user}>{children}</AdminShell>
}

