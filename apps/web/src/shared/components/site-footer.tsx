import Link from 'next/link'
import { ArrowUpRightIcon } from '@phosphor-icons/react/ssr'
import { BrandMark } from '@/shared/components/brand-mark'
import { PUBLIC_FRAME } from '@/shared/components/public-header'
import { iconSize } from '@/shared/components/ui/size'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

const REPO_URL = 'https://github.com/nextroad-dev/MuseCanvas'
const DEPLOY_DOC_URL = 'https://github.com/nextroad-dev/MuseCanvas/blob/main/deploy/README.md'

/** 构建期注入的版本号；未注入时显示 `dev`。 */
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION?.trim() || 'dev'

export interface SiteFooterProps {
  /** 当前法律文件：为对应链接添加 `aria-current`。 */
  current?: 'terms' | 'privacy'
  className?: string
}

const columnHeading = 'font-mono text-overline uppercase tracking-[0.06em] text-muted-foreground'
const columnLink =
  'inline-flex items-center gap-1 rounded-control text-sm text-foreground/85 transition-colors hover:text-foreground max-sm:min-h-[var(--control-lg)]'

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <nav aria-label={title} className="flex flex-col gap-2.5">
      <p className={columnHeading}>{title}</p>
      {children}
    </nav>
  )
}

/**
 * 公共页统一页脚：品牌简介 + 产品 / 部署 / 法律三列 + 版权与版本号。
 */
export function SiteFooter({ current, className }: SiteFooterProps) {
  return (
    <footer className={cn('border-t border-border bg-surface', className)}>
      <div className={cn(PUBLIC_FRAME, 'flex flex-col gap-10 pb-8 pt-14')}>
        <div className="flex flex-wrap justify-between gap-10">
          <div className="flex max-w-xs flex-col gap-3">
            <BrandMark variant="lockup" height={19} />
            <p className="text-sm leading-relaxed text-muted-foreground">
              可以装在自己服务器上的 AI 画图与视频创作工作室。
            </p>
          </div>

          <div className="flex flex-wrap gap-x-16 gap-y-8">
            <FooterColumn title="产品">
              <Link href={APP_ROUTES.home} className={columnLink}>
                首页
              </Link>
              <Link href={APP_ROUTES.generate} className={columnLink}>
                创作台
              </Link>
              <Link href={APP_ROUTES.library} className={columnLink}>
                作品图库
              </Link>
            </FooterColumn>

            <FooterColumn title="部署">
              <a href={DEPLOY_DOC_URL} target="_blank" rel="noopener noreferrer" className={columnLink}>
                部署说明
                <ArrowUpRightIcon weight="bold" aria-hidden="true" className={cn(iconSize.xs, 'text-muted-foreground')} />
              </a>
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={columnLink}>
                源码仓库
                <ArrowUpRightIcon weight="bold" aria-hidden="true" className={cn(iconSize.xs, 'text-muted-foreground')} />
              </a>
            </FooterColumn>

            <FooterColumn title="法律">
              <Link
                href={APP_ROUTES.terms}
                aria-current={current === 'terms' ? 'page' : undefined}
                className={cn(columnLink, current === 'terms' && 'font-medium text-accent')}
              >
                服务条款
              </Link>
              <Link
                href={APP_ROUTES.privacy}
                aria-current={current === 'privacy' ? 'page' : undefined}
                className={cn(columnLink, current === 'privacy' && 'font-medium text-accent')}
              >
                隐私政策
              </Link>
            </FooterColumn>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 font-mono text-xs text-muted-foreground">
          <span>© 2026 MuseCanvas</span>
          <span className="rounded-pill border border-border bg-tonal px-2.5 py-0.5 text-caption tabular-nums">
            v{APP_VERSION}
          </span>
        </div>
      </div>
    </footer>
  )
}
