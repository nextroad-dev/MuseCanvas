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
    <main className="flex flex-1 items-center justify-center px-4 py-16 md:px-8">
      <section
        aria-labelledby="setup-complete-title"
        className="flex w-full max-w-[var(--container-dialog-narrow)] flex-col gap-6 rounded-panel bg-surface p-6 text-foreground shadow-soft md:p-8"
      >
        <Badge tone="success" className="self-start">
          已完成
        </Badge>

        <div className="flex flex-col gap-2">
          <h1 id="setup-complete-title" className="text-title">
            安装已完成
          </h1>
          <p className="text-sm text-muted-foreground [text-wrap:pretty]">
            MuseCanvas 已初始化完成，初始化入口已关闭。现在可以使用刚才创建的管理员账号登录。
          </p>
        </div>

        <dl className="flex flex-col gap-1 rounded-control bg-tonal p-4">
          <dt className="text-xs text-muted-foreground">完成时间</dt>
          <dd className="font-mono text-sm tabular-nums text-foreground">
            {completedAt ? formatDateTime(completedAt) : '—'}
          </dd>
        </dl>

        <div className="flex flex-wrap items-center gap-3">
          <a href="/login" className={buttonVariants({ variant: 'primary' })}>
            去登录
          </a>
          <a href="/" className={buttonVariants({ variant: 'secondary' })}>
            去首页
          </a>
        </div>

        <p className={cn('text-xs text-muted-foreground')}>
          需要修改站点、邮件或存储配置时，请以管理员身份登录后进入后台设置。
        </p>
      </section>
    </main>
  )
}
