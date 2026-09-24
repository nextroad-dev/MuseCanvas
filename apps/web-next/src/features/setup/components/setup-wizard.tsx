'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  Globe,
  Key,
  Layers,
  Loader2,
  Mail,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'

interface SetupStatus {
  isConfigured: boolean
  sections?: Record<string, boolean>
}

const steps = [
  { id: 'site', label: '站点配置', icon: Globe },
  { id: 'smtp', label: 'SMTP 邮件与管理员', icon: Mail },
  { id: 'storage', label: '对象存储 (S3)', icon: Database },
  { id: 'providers', label: 'AI 模型与供应商', icon: Sparkles },
  { id: 'review', label: '系统初始化完成', icon: CheckCircle2 },
]

export function SetupWizard() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const stepParam = searchParams.get('step') || 'site'

  const [currentStepIndex, setCurrentStepIndex] = useState(
    Math.max(0, steps.findIndex((s) => s.id === stepParam)),
  )

  const { data: status, isLoading } = useQuery({
    queryKey: ['setup', 'status'],
    queryFn: async () => {
      const res = await api<SetupStatus>(API_ENDPOINTS.setup.status)
      return res.data || null
    },
  })

  useEffect(() => {
    const idx = steps.findIndex((s) => s.id === stepParam)
    if (idx >= 0) setCurrentStepIndex(idx)
  }, [stepParam])

  const currentStep = steps[currentStepIndex] || steps[0]

  function navigateToStep(idx: number) {
    if (idx >= 0 && idx < steps.length) {
      setCurrentStepIndex(idx)
      router.push(`/setup?step=${steps[idx].id}`)
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-foreground">
      {/* Header */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-surface px-6">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold tracking-tight text-foreground">MuseCanvas</span>
          <span className="rounded bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-strong">
            系统安装向导
          </span>
        </div>
        {status?.isConfigured && (
          <span className="text-xs text-muted-foreground">系统已完成初始配置</span>
        )}
      </header>

      {/* Stepper Navigation */}
      <div className="border-b border-border bg-surface-subtle/50 px-6 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          {steps.map((step, idx) => {
            const Icon = step.icon
            const isActive = idx === currentStepIndex
            const isCompleted = idx < currentStepIndex
            return (
              <button
                key={step.id}
                type="button"
                onClick={() => navigateToStep(idx)}
                className={`flex items-center gap-2 text-xs font-medium transition-colors ${
                  isActive
                    ? 'text-accent font-semibold'
                    : isCompleted
                      ? 'text-foreground'
                      : 'text-muted-foreground'
                }`}
              >
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs ${
                    isActive
                      ? 'border-accent bg-accent text-accent-contrast'
                      : isCompleted
                        ? 'border-border bg-surface text-success'
                        : 'border-border bg-surface text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <CheckCircle2 className="h-4 w-4" /> : idx + 1}
                </div>
                <span className="hidden sm:inline">{step.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Main Content Area */}
      <main className="flex flex-1 justify-center p-6">
        <div className="w-full max-w-2xl rounded-[var(--radius-card)] border border-border bg-surface p-8 shadow-sm space-y-6">
          <div className="border-b border-border pb-4">
            <h2 className="text-lg font-bold text-foreground">{currentStep.label}</h2>
            <p className="text-xs text-muted-foreground">
              为 MuseCanvas 实例配置核心基础设施参数，可随时在管理后台更改。
            </p>
          </div>

          {currentStep.id === 'site' && (
            <div className="space-y-4 text-xs text-muted-foreground">
              <p>
                站点配置包括服务域名（例如 <code className="font-mono">https://musecanvas.example.com</code>）及公开访问端点。
              </p>
              <div className="rounded-[var(--radius-control)] border border-border bg-surface-subtle p-4">
                <p className="font-medium text-foreground">环境变量自适应检查</p>
                <p className="mt-1">
                  服务已检测到本地 Next.js / API 运行配置。请确保服务端 <code className="font-mono">BASE_URL</code> 已经正确指向本实例。
                </p>
              </div>
            </div>
          )}

          {currentStep.id === 'smtp' && (
            <div className="space-y-4 text-xs text-muted-foreground">
              <p>
                配置用于向用户发送邮箱登录验证码 (OTP) 的 SMTP 发信服务器。
              </p>
              <div className="rounded-[var(--radius-control)] border border-border bg-surface-subtle p-4">
                <p className="font-medium text-foreground">SMTP 发信测试</p>
                <p className="mt-1">
                  开发环境下可直接查看后端控制台输出的 OTP 验证码以实现免发信极速调试。
                </p>
              </div>
            </div>
          )}

          {currentStep.id === 'storage' && (
            <div className="space-y-4 text-xs text-muted-foreground">
              <p>
                对象存储 (S3 兼容 / 阿里云 OSS / 腾讯云 COS / Cloudflare R2 / 本地 MinIO) 用于持久化保存用户生成的图片资产。
              </p>
              <div className="rounded-[var(--radius-control)] border border-border bg-surface-subtle p-4">
                <p className="font-medium text-foreground">S3 存储桶就绪状态</p>
                <p className="mt-1">
                  Worker 异步生成流水线将在生成完毕后自动将资产直传至目标存储桶并签发访问 URL。
                </p>
              </div>
            </div>
          )}

          {currentStep.id === 'providers' && (
            <div className="space-y-4 text-xs text-muted-foreground">
              <p>
                配置上游生成大模型服务凭据（如 OpenAI DALL·E 3 / 火山引擎 Seedream / Anthropic Claude / Google Veo）。
              </p>
              <div className="rounded-[var(--radius-control)] border border-border bg-surface-subtle p-4">
                <p className="font-medium text-foreground">凭据即时管理</p>
                <p className="mt-1">
                  可在系统完成引导后，在管理员后台随时添加多个 API Key 并配置自动负载均衡或费率。
                </p>
              </div>
            </div>
          )}

          {currentStep.id === 'review' && (
            <div className="space-y-4 text-center py-6">
              <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
              <h3 className="text-base font-bold text-foreground">安装与环境检查就绪</h3>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                您的 MuseCanvas 实例已具备运行所需的所有关键组件。现在即可进入创作控制台或管理员后台。
              </p>
              <div className="pt-4 flex justify-center gap-3">
                <a
                  href="/generate"
                  className="rounded-[var(--radius-control)] bg-accent px-5 py-2 text-xs font-medium text-accent-contrast hover:bg-accent-hover"
                >
                  进入创作端
                </a>
                <a
                  href="/admin"
                  className="rounded-[var(--radius-control)] border border-border bg-surface px-5 py-2 text-xs font-medium text-foreground hover:bg-surface-subtle"
                >
                  进入管理后台
                </a>
              </div>
            </div>
          )}

          {/* Bottom Action buttons */}
          <div className="flex justify-between border-t border-border pt-4">
            <button
              type="button"
              onClick={() => navigateToStep(currentStepIndex - 1)}
              disabled={currentStepIndex === 0}
              className="flex items-center gap-1 rounded-[var(--radius-control)] border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-subtle disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              上一步
            </button>

            {currentStepIndex < steps.length - 1 && (
              <button
                type="button"
                onClick={() => navigateToStep(currentStepIndex + 1)}
                className="flex items-center gap-1 rounded-[var(--radius-control)] bg-accent px-4 py-1.5 text-xs font-medium text-accent-contrast hover:bg-accent-hover"
              >
                下一步
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
