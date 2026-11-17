import Link from 'next/link'
import { ArrowRightIcon, ArrowUpRightIcon } from '@phosphor-icons/react/ssr'
import { BrandMark } from '@/shared/components/brand-mark'
import { buttonVariants } from '@/shared/components/ui/button-variants'
import { iconSize } from '@/shared/components/ui/size'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { LandingFrame } from './landing-frame'

const DEPLOY_DOC_URL = 'https://github.com/nextroad-dev/MuseCanvas/blob/main/deploy/README.md'

/** 反相主按钮：浅色主题下为白底墨字，深色主题下保持高对比。 */
const ctaPrimary = cn(
  buttonVariants({ variant: 'primary' }),
  'min-h-[var(--control-cta)] gap-2.5 rounded-pill bg-surface px-7 text-base text-foreground hover:bg-surface-hover max-sm:min-h-[var(--control-cta)]',
)

const ctaSecondary =
  'motion-press inline-flex min-h-[var(--control-cta)] items-center justify-center gap-2 rounded-pill border border-border-control px-7 text-base font-medium text-foreground-inverse transition-colors hover:bg-foreground-inverse/10'

/**
 * 收尾区：左标志 + 「现在就画第一张」，右两个 52px pill 按钮。
 *
 * 用 `bg-foreground text-foreground-inverse` 而不是写死深色：浅色主题下是墨黑块，
 * 深色主题下反相成浅色块，两个主题都成立。
 */
export function CtaSection() {
  return (
    <section aria-labelledby="cta-title" className="bg-foreground text-foreground-inverse">
      <LandingFrame className="flex flex-wrap items-end justify-between gap-10 py-20 md:py-28">
        <div className="flex min-w-0 flex-col gap-6">
          <BrandMark
            variant="mark"
            height={44}
            className="brightness-0 invert dark:brightness-100 dark:invert-0"
          />
          <h2 id="cta-title" className="font-display text-cta text-foreground-inverse">
            现在就画第一张
          </h2>
        </div>

        <div className="flex flex-wrap gap-3.5">
          <Link href={APP_ROUTES.generate} className={ctaPrimary}>
            开始创作
            <ArrowRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
          </Link>
          <a href={DEPLOY_DOC_URL} target="_blank" rel="noopener noreferrer" className={ctaSecondary}>
            部署到自己的服务器
            <ArrowUpRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
          </a>
        </div>
      </LandingFrame>
    </section>
  )
}
