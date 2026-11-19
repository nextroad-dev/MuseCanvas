import Link from 'next/link'
import { ArrowRightIcon, ArrowUpRightIcon } from '@phosphor-icons/react/ssr'
import { BrandMark } from '@/shared/components/brand-mark'
import { Reveal } from '@/shared/components/reveal'
import { Button, iconSize } from '@/shared/components/ui'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { LandingFrame } from './landing-frame'

const DEPLOY_DOC_URL = 'https://github.com/nextroad-dev/MuseCanvas/blob/main/deploy/README.md'

/**
 * 收尾区：反相高对比通栏（浅色主题为深墨底，深色主题自动反相为冷浅底），
 * 左侧品牌标志 + 标题，右侧统一 `Button`（`size="lg"` `rounded-control`）主次入口。
 */
export function CtaSection() {
  return (
    <section aria-labelledby="cta-title" className="bg-foreground text-foreground-inverse">
      <Reveal>
        <LandingFrame className="flex flex-wrap items-end justify-between gap-10 py-20 md:py-28">
          <div className="flex min-w-0 max-w-xl flex-col items-start gap-5">
            <BrandMark
              variant="mark"
              height={40}
              className="brightness-0 invert dark:brightness-100 dark:invert-0"
            />
            <h2 id="cta-title" className="m-0 font-display text-cta text-foreground-inverse">
              现在就画第一张
            </h2>
            <p className="m-0 text-base text-foreground-inverse/75">
              进入创作台写下第一段构想，或按文档把 MuseCanvas 部署到你自己的服务器。
            </p>
          </div>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap">
            <Button
              asChild
              variant="primary"
              size="lg"
              className="w-full bg-surface px-6 text-base text-foreground not-disabled:hover:bg-surface-hover not-disabled:active:bg-tonal sm:w-auto"
            >
              <Link href={APP_ROUTES.generate}>
                开始创作
                <ArrowRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
              </Link>
            </Button>

            <Button
              asChild
              variant="outline"
              size="lg"
              className="w-full border-border-control/40 bg-transparent px-6 text-base text-foreground-inverse not-disabled:hover:border-border-strong not-disabled:hover:bg-foreground-inverse/10 not-disabled:active:bg-foreground-inverse/15 sm:w-auto"
            >
              <a href={DEPLOY_DOC_URL} target="_blank" rel="noopener noreferrer">
                部署到自己的服务器
                <ArrowUpRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
              </a>
            </Button>
          </div>
        </LandingFrame>
      </Reveal>
    </section>
  )
}
