import { ArrowRightIcon, CheckCircleIcon } from '@phosphor-icons/react/ssr'

import { Badge, Card, buttonVariants, iconSize } from '@/shared/components/ui'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { formatDateTime } from '@/shared/lib/format'

export interface SetupCompleteViewProps {
  completedAt: string | null
}

/**
 * 安装完成后的落地页（RSC 首屏与客户端提交成功后共用）。
 * 初始化入口已关闭：这里不再提供向导操作，只给去登录 / 去首页两个去处。
 */
export function SetupCompleteView({ completedAt }: SetupCompleteViewProps) {
  return (
    <div className="motion-page-enter mx-auto w-full max-w-[var(--container-dialog-narrow)]">
      <Card variant="surface" density="none" role="region" aria-labelledby="setup-complete-title">
        <div className="flex flex-col gap-5 px-5 py-6 sm:px-6 sm:py-7">
          <div className="flex items-center justify-between gap-3">
            <div className="flex size-11 items-center justify-center rounded-card border border-success-border bg-success-soft text-success">
              <CheckCircleIcon weight="duotone" aria-hidden="true" className={iconSize.lg} />
            </div>
            <Badge tone="success">已完成</Badge>
          </div>

          <div className="flex flex-col gap-1.5">
            <h1 id="setup-complete-title" className="text-title tracking-tight text-foreground">
              安装已完成
            </h1>
            <p className="text-sm text-muted-foreground [text-wrap:pretty]">
              MuseCanvas 已初始化完成，初始化入口已关闭。现在可以使用刚才创建的管理员账号登录并开始创作。
            </p>
          </div>

          <dl className="flex flex-col gap-1 rounded-control border border-border/70 bg-tonal px-4 py-3">
            <dt className="text-xs font-medium text-muted-foreground">完成时间</dt>
            <dd className="font-mono text-sm tabular-nums text-foreground">
              {completedAt ? (
                <time dateTime={completedAt} suppressHydrationWarning>
                  {formatDateTime(completedAt)}
                </time>
              ) : (
                '—'
              )}
            </dd>
          </dl>

          <div className="flex flex-wrap items-center gap-2.5">
            <a
              href={APP_ROUTES.login}
              className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'gap-1.5')}
            >
              <span>去登录</span>
              <ArrowRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
            </a>
            <a href={APP_ROUTES.home} className={buttonVariants({ variant: 'outline', size: 'md' })}>
              去首页
            </a>
          </div>
        </div>

        <div className="border-t border-border/70 px-5 py-3.5 sm:px-6">
          <p className="text-xs text-muted-foreground">
            需要修改站点、邮件或存储配置时，请以管理员身份登录后进入后台设置。
          </p>
        </div>
      </Card>
    </div>
  )
}
