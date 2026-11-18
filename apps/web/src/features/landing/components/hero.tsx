import Link from 'next/link'
import { ArrowRightIcon, ImagesIcon, SparkleIcon } from '@phosphor-icons/react/ssr'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { iconSize } from '@/shared/components/ui/size'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { SHOWCASE_ITEMS } from '@/shared/lib/showcase'
import { LandingFrame } from './landing-frame'
import { ShowcaseFrame } from './showcase-frame'

const HERO_FILE = 'ratio-3x4.webp'

/** 画板 04 的横向作品条：3 件作品，宽度 170 / 220 / 170、高 220。 */
const MOBILE_STRIP: { file: string; label: string; widthClass: string }[] = [
  { file: 'ratio-3x4.webp', label: '3:4', widthClass: 'w-[170px]' },
  { file: 'ratio-16x9.webp', label: '16:9', widthClass: 'w-[220px]' },
  { file: 'ratio-1x1.webp', label: '1:1', widthClass: 'w-[170px]' },
]

const ctaPrimary = cn(
  buttonVariants({ variant: 'primary' }),
  'min-h-[var(--control-cta)] w-full justify-center gap-2.5 rounded-pill px-7 text-base shadow-soft max-sm:min-h-[var(--control-cta)] sm:w-auto',
)
const ctaSecondary = cn(
  buttonVariants({ variant: 'outline' }),
  'min-h-[var(--control-cta)] w-full justify-center gap-2 rounded-pill bg-surface px-6 text-base max-sm:min-h-[var(--control-lg)] sm:w-auto',
)

/**
 * 首屏（Google Sans AI Studio 风格）：左侧 studio badge + 大标题 + 副标题 + 双 pill CTA，
 * 右侧 3:4 作品画框。<640px 换成纵向按钮 + 横向滚动作品条；首屏不做滚动揭示。
 */
export function Hero() {
  const heroImage = SHOWCASE_ITEMS.find((item) => item.file === HERO_FILE)
  const strip = MOBILE_STRIP.map((entry) => ({
    ...entry,
    item: SHOWCASE_ITEMS.find((item) => item.file === entry.file),
  }))

  return (
    <section aria-labelledby="hero-title" className="bg-canvas">
      <LandingFrame className="grid grid-cols-1 items-center gap-10 pb-0 pt-10 sm:gap-16 sm:pb-24 sm:pt-16 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col items-start gap-7">
          <span className="inline-flex max-w-full flex-wrap items-center gap-2 rounded-pill bg-accent-soft px-3.5 py-1.5 text-ui font-medium text-accent">
            <SparkleIcon weight="duotone" aria-hidden="true" className={cn(iconSize.sm, 'shrink-0')} />
            AI 创意工作室 · 自托管图像与视频生成
          </span>

          <h1 id="hero-title" className="font-display text-hero break-words text-foreground">
            让创意
            <br />
            快速落地
          </h1>

          <p className="max-w-xl text-copy text-muted-foreground sm:text-lead">
            把构想写成一段文字，AI 即刻生成画面，作品自动保存至个人图库。
          </p>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
            <Link href={APP_ROUTES.generate} className={ctaPrimary}>
              开始创作
              <ArrowRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
            </Link>

            <Link href="#works" className={ctaSecondary}>
              <ImagesIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
              先看看作品
            </Link>
          </div>
        </div>

        <figure className="m-0 hidden min-w-0 flex-col sm:flex">
          <div className="rounded-panel border border-border bg-surface p-2.5 shadow-floating">
            {heroImage ? (
              <ShowcaseFrame
                file={heroImage.file}
                label={heroImage.label}
                sizes="(min-width: 1024px) 50vw, 100vw"
                priority
                className="aspect-[3/4] max-h-[600px] w-full rounded-card"
              >
                <figcaption className="media-scrim absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 px-5 pb-4 pt-12 text-sm text-on-media">
                  <span className="truncate font-medium">{heroImage.prompt}</span>
                  <span className="shrink-0 rounded-pill bg-surface/20 px-2.5 py-0.5 font-mono text-caption backdrop-blur-sm">
                    {heroImage.label}
                  </span>
                </figcaption>
              </ShowcaseFrame>
            ) : (
              <div className="aspect-[3/4] max-h-[600px] w-full rounded-card bg-tonal" aria-hidden="true" />
            )}
          </div>
        </figure>
      </LandingFrame>

      {/* 窄屏用横向作品条替代右侧大图，容器自身横向滚动，页面不溢出。 */}
      <div className="mt-8 overflow-x-auto px-4 pb-10 sm:hidden">
        <ul className="m-0 flex w-max list-none gap-3 p-0">
          {strip.map((entry) =>
            entry.item ? (
              <li key={entry.file} className={cn('flex shrink-0 flex-col gap-2', entry.widthClass)}>
                <ShowcaseFrame
                  file={entry.item.file}
                  label={entry.item.label}
                  sizes={entry.widthClass === 'w-[220px]' ? '220px' : '170px'}
                  className="h-[220px] w-full rounded-card border border-border"
                />
                <span className="truncate text-center text-sm text-muted-foreground">{entry.item.prompt}</span>
              </li>
            ) : null,
          )}
        </ul>
      </div>
    </section>
  )
}
