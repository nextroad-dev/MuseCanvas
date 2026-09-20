import { SetupWizard } from '@/features/setup/components/setup-wizard'
import { Suspense } from 'react'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '系统安装向导 - MuseCanvas',
  description: 'MuseCanvas 实例初始化与环境配置',
}

export default function SetupPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center">正在加载向导...</div>}>
      <SetupWizard />
    </Suspense>
  )
}
