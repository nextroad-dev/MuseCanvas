import Link from 'next/link'
import { ArrowUpRightIcon } from '@phosphor-icons/react/ssr'
import { BrandMark } from '@/shared/components/brand-mark'
import { PUBLIC_FRAME } from '@/shared/components/public-header'
import { iconSize } from '@/shared/components/ui/size'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'

const REPO_URL = 'https://github.com/nextroad-dev/MuseCanvas'
const DEPLOY_DOC_URL = 'https://github.com/nextroad-dev/MuseCanvas/blob/main/deploy/README.md'

/** 构建期注入的版本号；未注入时显示 `dev`，不猜发布版本。 */
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION?.trim() || 'dev'

export interface SiteFooterProps {
  /** 当前法律文件：只用来给对应链接加 `aria-current`。 */
  current?: 'terms' | 'privacy'
  className?: string
}

const columnHeading = 'font-mono text-overline uppercase tracking-[0.06em] text-muted-foreground'
const columnLink =
  'inline-flex items-center gap-1 rounded-control text-sm text-foreground/85 transition-colors hover:text-foreground max-sm:min-h-[var(--control-touch)]'

/** 三列导航共用的结构：mono 小标题 + 竖排链接。 */
function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <nav aria-label={title} className="flex flex-col gap-2.5">
      <p className={columnHeading}>{title}</p>
      {children}
    </nav>
  )
}

/**
 * 公共页页脚：品牌 + 一句话介绍、产品 / 部署 / 法律三列、
 * 底行版权与版本号。保持简洁 Studio 表面与细腻分割线。
 */
export function SiteFooter({ current, className }: SiteFooterProps) {
  return (
    <footer className={cn('border-t border-border bg-surface', className)}>
      <div className={cn(PUBLIC_FRAME, 'flex flex-col gap-12 pb-10 pt-16')}>
        <div className="flex flex-wrap justify-between gap-10">
          <div className="flex max-w-xs flex-col gap-3.5">
            <BrandMark variant="lockup" height={19} />
            <p className="text-sm leading-relaxed text-muted-foreground">
              可以装在自己服务器上的 AI 画图与视频创作工作室。
            </p>
          </div>

          <div className="flex flex-wrap gap-x-16 gap-y-10">
            <FooterColumn title="产品">
              <Link href="/#works" className={columnLink}>
                作品
              </Link>
              <Link href="/#capabilities" className={columnLink}>
                能力
              </Link>
              <Link href="/#workflow" className={columnLink}>
                流程
              </Link>
              <Link href={APP_ROUTES.generate} className={columnLink}>
                创作台
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
                用户协议
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
