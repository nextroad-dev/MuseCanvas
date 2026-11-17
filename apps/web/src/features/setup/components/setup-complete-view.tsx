import { ArrowRightIcon, CheckCircleIcon, SparkleIcon } from '@phosphor-icons/react/ssr'
import { Badge, buttonVariants } from '@/shared/components/ui'
import { formatDateTime } from '@/shared/lib/format'
import { cn } from '@/shared/lib/cn'

export interface SetupCompleteViewProps {
  completedAt: string | null
}

/**
 * 安装完成后的落地页（RSC 首屏与客户端提交成功后共用）。
 * 初始化入口已关闭：这里不再提供向导操作，只给去登录 / 去首页两个去处。
 */
export function SetupCompleteView({ completedAt }: SetupCompleteViewProps) {
  return (
    <main className="motion-page-enter flex flex-1 items-center justify-center px-4 py-14 md:px-8">
      <section
        aria-labelledby="setup-complete-title"
        className="flex w-full max-w-[var(--container-dialog-narrow)] flex-col gap-6 rounded-panel border border-border bg-surface p-7 text-foreground shadow-floating md:p-9"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-card bg-success-soft text-success">
            <CheckCircleIcon weight="duotone" aria-hidden="true" className="h-7 w-7" />
          </div>
          <Badge tone="success" className="gap-1.5 px-3 py-1">
            <SparkleIcon weight="fill" aria-hidden="true" className="h-3 w-3" />
            <span>已完成</span>
          </Badge>
        </div>

        <div className="flex flex-col gap-2">
          <h1 id="setup-complete-title" className="text-title font-medium tracking-tight text-foreground">
            安装已完成
          </h1>
          <p className="text-compact text-muted-foreground [text-wrap:pretty]">
            MuseCanvas 已初始化完成，初始化入口已关闭。现在可以使用刚才创建的管理员账号登录并开始创作。
          </p>
        </div>

        <dl className="flex flex-col gap-1.5 rounded-card border border-border bg-canvas/70 p-4">
          <dt className="text-xs font-medium text-muted-foreground">完成时间</dt>
          <dd className="font-mono text-sm tabular-nums text-foreground">
            {completedAt ? formatDateTime(completedAt) : '—'}
          </dd>
        </dl>

        <div className="flex flex-wrap items-center gap-3">
          <a href="/login" className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'gap-2')}>
            <span>去登录</span>
            <ArrowRightIcon weight="bold" aria-hidden="true" className="h-4 w-4" />
          </a>
          <a href="/" className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
            去首页
          </a>
        </div>

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          需要修改站点、邮件或存储配置时，请以管理员身份登录后进入后台设置。
        </p>
      </section>
    </main>
  )
}
