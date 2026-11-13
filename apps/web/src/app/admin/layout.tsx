import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'

import { AdminShell } from '@/features/admin/components/admin-shell'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { getSessionUser } from '@/shared/services/server-api'

/**
 * 后台统一门禁（RSC）：`/admin/**` 全部继承这一层。
 *
 * · 未登录 / 会话失效 → `/login?next=/admin`；
 * · 已登录但非管理员 → 回首页（不暴露后台是否存在）；
 * · 后端不可用时 `getSessionUser` 抛错，交给 `error.tsx`，不伪装成未登录。
 *
 * 读 Cookie 决定了本段必须动态渲染，显式声明避免被误当作静态段。
 */
export const dynamic = 'force-dynamic'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser()

  if (!user) {
    redirect(`${APP_ROUTES.login}?next=${encodeURIComponent(APP_ROUTES.admin)}`)
  }
  if (user.role !== 'admin') {
    redirect(APP_ROUTES.home)
  }

  return <AdminShell user={user}>{children}</AdminShell>
}
