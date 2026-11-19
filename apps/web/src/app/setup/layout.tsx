import type { ReactNode } from 'react'

import { FocusedShell } from '@/shared/components/shells'
import { Badge } from '@/shared/components/ui'

/**
 * `/setup` 的外框：基于 `FocusedShell`（56px 极简顶栏 + 表单居中容器 + 主题切换），
 * 不渲染任何顶部进度步骤条。
 *
 * 安装向导是首装期的匿名可达页面，本布局不读 Cookie、不做重定向——是否已完成
 * 由 `page.tsx` 的服务端状态决定。
 */
export default function SetupLayout({ children }: { children: ReactNode }) {
  return (
    <FocusedShell maxWidth="form" headerRight={<Badge tone="neutral">系统初始化</Badge>}>
      {children}
    </FocusedShell>
  )
}
