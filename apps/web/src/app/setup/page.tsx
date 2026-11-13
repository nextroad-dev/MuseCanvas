import type { Metadata } from 'next'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type { SetupConfigDto, SetupStatusResponse } from '@musecanvas/contracts'

import { SetupCompleteView } from '@/features/setup/components/setup-complete-view'
import { SetupWizard } from '@/features/setup/components/setup-wizard'
import { parseSetupStepId } from '@/features/setup/lib/setup-steps'
import { Alert, buttonVariants } from '@/shared/components/ui'
import { ApiError, getSetupStatus, serverApiFetch } from '@/shared/services/server-api'

/**
 * 安装向导入口（RSC）：
 * · `GET /setup/status` 是公开端点，决定「已完成」还是「继续向导」；
 * · 已完成 → 只显示完成页（去登录 / 去首页），不再渲染向导；
 * · 未完成 → 尝试带当前 Cookie 读 `/setup/config`：读成功说明初始化访问已开放
 *   （领取会话 / 管理员会话 / claim-optional 开放模式），把首屏配置直接交给客户端，
 *   避免先闪一个空表单。401 属正常「尚未领取」，由客户端在领取后自行读取。
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: '系统初始化',
  description: 'MuseCanvas 实例初始化与环境配置',
}

type SetupSearchParams = Promise<Record<string, string | string[] | undefined>>

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function SetupUnavailable() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16 md:px-8">
      <div className="w-full max-w-[var(--container-dialog-narrow)]">
        <Alert
          tone="danger"
          role="alert"
          title="无法读取安装状态"
          action={
            <a href="/setup" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              重新加载
            </a>
          }
        >
          无法连接 API 服务，或服务尚未启动完成。请确认后端已运行后重新加载本页。
        </Alert>
      </div>
    </main>
  )
}

export default async function SetupPage({ searchParams }: { searchParams: SetupSearchParams }) {
  const params = await searchParams
  const initialStep = parseSetupStepId(firstValue(params.step))

  let status: SetupStatusResponse | null = null
  try {
    status = await getSetupStatus()
  } catch {
    status = null
  }

  if (!status) return <SetupUnavailable />
  if (status.setupComplete) return <SetupCompleteView completedAt={status.completedAt} />

  let config: SetupConfigDto | null = null
  try {
    config = await serverApiFetch<SetupConfigDto>(API_ENDPOINTS.setup.config)
  } catch (error) {
    // 401/403 = 还没领取初始化码（或会话已过期），属于预期分支，交给客户端处理；
    // 其它错误（后端不可用等）交给错误边界，避免把基础设施故障伪装成「还没领取」。
    if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) throw error
  }

  return <SetupWizard initialStatus={status} initialConfig={config} initialStep={initialStep} />
}
