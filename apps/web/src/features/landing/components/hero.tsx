import Link from 'next/link'
import { ArrowRightIcon } from '@phosphor-icons/react/ssr'
import { buttonVariants } from '@/shared/components/ui/button-variants'
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
  'min-h-[var(--control-cta)] w-full justify-center gap-3 px-[26px] text-base max-sm:min-h-[var(--control-cta)] sm:w-auto',
)
const ctaSecondary = cn(
  buttonVariants({ variant: 'secondary', size: 'lg' }),
  'w-full justify-center text-base max-sm:min-h-[var(--control-lg)] sm:hidden',
)

/**
 * 首屏（画板 01 / 04）：左侧衬线大标题 + 副标题 + 双 CTA，右侧 3:4 作品图。
 * <640px 换成画板 04 的纵向按钮 + 横向滚动作品条；首屏不做滚动揭示。
 */
export function Hero() {
  const heroImage = SHOWCASE_ITEMS.find((item) => item.file === HERO_FILE)
  const strip = MOBILE_STRIP.map((entry) => ({
    ...entry,
    item: SHOWCASE_ITEMS.find((item) => item.file === entry.file),
  }))

  return (
    <section aria-labelledby="hero-title">
      <LandingFrame className="grid grid-cols-1 items-center gap-8 pb-0 pt-8 sm:gap-16 sm:pb-28 sm:pt-16 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-8">
          <h1 id="hero-title" className="font-display text-hero text-foreground">
            让创意
            <br />
            快速落地
          </h1>

          <p className="max-w-xl text-copy text-foreground/80 sm:text-lead">
            把构想写成一段文字，AI 即刻生成画面，作品自动保存至图库。
          </p>

          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-7">
            <Link href={APP_ROUTES.generate} className={ctaPrimary}>
              开始创作
              <ArrowRightIcon weight="bold" aria-hidden="true" className="size-[18px]" />
            </Link>

            <Link
              href="#works"
              className="hidden text-copy font-medium text-foreground underline decoration-1 underline-offset-[6px] transition-colors hover:text-muted-foreground sm:inline-flex"
            >
              先看看作品
            </Link>
            <Link href="#works" className={ctaSecondary}>
              先看看作品
            </Link>
          </div>
        </div>

        <figure className="m-0 hidden min-w-0 flex-col gap-3.5 sm:flex">
          {heroImage ? (
            <ShowcaseFrame
              file={heroImage.file}
              label={heroImage.label}
              sizes="(min-width: 1024px) 50vw, 100vw"
              priority
              className="aspect-[3/4] max-h-[620px] w-full rounded-[6px]"
            />
          ) : (
            <div className="aspect-[3/4] max-h-[620px] w-full rounded-[6px] bg-tonal" aria-hidden="true" />
          )}
        </figure>
      </LandingFrame>

      {/* 画板 04：窄屏用横向作品条替代右侧大图，容器自身横向滚动，页面不溢出。 */}
      <div className="mt-7 overflow-x-auto px-4 pb-10 sm:hidden">
        <ul className="m-0 flex w-max list-none gap-3 p-0">
          {strip.map((entry) =>
            entry.item ? (
              <li key={entry.file} className={cn('flex shrink-0 flex-col gap-2', entry.widthClass)}>
                <ShowcaseFrame
                  file={entry.item.file}
                  label={entry.item.label}
                  sizes={entry.widthClass === 'w-[220px]' ? '220px' : '170px'}
                  className="h-[220px] w-full rounded-[6px]"
                />
                <span className="text-center text-sm text-foreground/80">{entry.item.prompt}</span>
              </li>
            ) : null,
          )}
        </ul>
      </div>
    </section>
  )
}
