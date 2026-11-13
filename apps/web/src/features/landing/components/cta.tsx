import Link from 'next/link'
import { BrandMark } from '@/shared/components/brand-mark'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { LandingFrame } from './landing-frame'

const DEPLOY_DOC_URL = 'https://github.com/nextroad-dev/MuseCanvas/blob/main/deploy/README.md'

/** 深色收尾区的白底主按钮：主按钮配方 + 反相表面。 */
const ctaPrimary = cn(
  buttonVariants({ variant: 'primary' }),
  'min-h-[var(--control-cta)] bg-surface px-[26px] text-base text-foreground hover:bg-surface-hover max-sm:min-h-[var(--control-cta)]',
)

const ctaSecondary =
  'motion-press inline-flex min-h-[var(--control-cta)] items-center justify-center rounded-control border border-border-control px-[26px] text-base font-medium text-foreground-inverse transition-colors hover:bg-foreground-inverse/10'

/**
 * 深色收尾区（画板 01）：左标志 + 衬线「现在就画第一张」，右两个 52px 按钮。
 *
 * 用 `bg-foreground text-foreground-inverse` 而不是写死深色：浅色主题下是墨黑块，
 * 深色主题下反相成浅色块，两个主题都成立。品牌标志在浅色主题里反白，
 * 深色主题（浅底）恢复原色。
 */
export function CtaSection() {
  return (
    <section aria-labelledby="cta-title" className="bg-foreground text-foreground-inverse">
      <LandingFrame className="flex flex-wrap items-end justify-between gap-12 py-24 md:py-30">
        <div className="flex min-w-0 flex-col gap-7">
          <BrandMark
            variant="mark"
            height={46}
            className="brightness-0 invert dark:brightness-100 dark:invert-0"
          />
          <h2 id="cta-title" className="font-display text-cta text-foreground-inverse">
            现在就画第一张
          </h2>
        </div>

        <div className="flex flex-wrap gap-4">
          <Link href={APP_ROUTES.generate} className={ctaPrimary}>
            开始创作
          </Link>
          <a href={DEPLOY_DOC_URL} target="_blank" rel="noopener noreferrer" className={ctaSecondary}>
            部署到自己的服务器
          </a>
        </div>
      </LandingFrame>
    </section>
  )
}
