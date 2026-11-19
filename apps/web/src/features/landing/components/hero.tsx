import type { CSSProperties } from 'react'
import Link from 'next/link'
import { ArrowRightIcon, ImagesIcon, SparkleIcon } from '@phosphor-icons/react/ssr'
import { Badge, Button, Card, iconSize } from '@/shared/components/ui'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { SHOWCASE_ITEMS } from '@/shared/lib/showcase'
import { LandingFrame } from './landing-frame'
import { ShowcaseFrame } from './showcase-frame'

const HERO_FILE = 'ratio-3x4.webp'

/** 窄屏横向作品条：3 件不同画幅作品，容器内横向滚动不撑破视口。 */
const MOBILE_STRIP: { file: string; widthClass: string }[] = [
  { file: 'ratio-3x4.webp', widthClass: 'w-44' },
  { file: 'ratio-16x9.webp', widthClass: 'w-56' },
  { file: 'ratio-1x1.webp', widthClass: 'w-44' },
]

const STUDIO_HIGHLIGHTS = [
  { label: '多模型切换', detail: '图像与视频统一调度' },
  { label: '图库自动归档', detail: '原图查看、下载与批量管理' },
  { label: '完全自托管', detail: '部署在自己的服务器与存储上' },
]

/**
 * 落地页首屏（Cool Gray-White Studio）：
 * 左侧编辑式标题、简介、主/次 `size="lg"` `rounded-control` CTA 与三项工作室注脚；
 * 右侧 `Card` panel 承载 3:4 作品画框（`StaticImage` 高优先级加载）。
 * 首屏直接入场（`motion-page-enter` + `motion-stagger`），不做滚动揭示延迟。
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
          <div style={{ '--stagger-index': 0 } as CSSProperties} className="motion-page-enter motion-stagger">
            <Badge
              tone="accent"
              variant="soft"
              icon={<SparkleIcon weight="duotone" />}
              className="gap-1.5 px-3 py-1 text-ui"
            >
              AI 创意工作室 · 自托管图像与视频生成
            </Badge>
          </div>

          <h1
            id="hero-title"
            style={{ '--stagger-index': 1 } as CSSProperties}
            className="motion-page-enter motion-stagger font-display text-hero break-words text-foreground"
          >
            让创意
            <br />
            快速落地
          </h1>

          <p
            style={{ '--stagger-index': 2 } as CSSProperties}
            className="motion-page-enter motion-stagger max-w-xl text-copy text-muted-foreground sm:text-lead"
          >
            把构想写成一段文字，AI 即刻生成画面，作品自动保存至个人图库。
          </p>

          <div
            style={{ '--stagger-index': 3 } as CSSProperties}
            className="motion-page-enter motion-stagger flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center"
          >
            <Button asChild variant="primary" size="lg" className="w-full px-6 text-base shadow-soft sm:w-auto">
              <Link href={APP_ROUTES.generate}>
                开始创作
                <ArrowRightIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
              </Link>
            </Button>

            <Button asChild variant="outline" size="lg" className="w-full px-6 text-base sm:w-auto">
              <Link href="#works">
                <ImagesIcon weight="duotone" aria-hidden="true" className={iconSize.sm} />
                先看看作品
              </Link>
            </Button>
          </div>

          <dl
            style={{ '--stagger-index': 4 } as CSSProperties}
            className="motion-page-enter motion-stagger m-0 grid w-full max-w-xl grid-cols-1 gap-4 border-t border-border pt-6 sm:grid-cols-3"
          >
            {STUDIO_HIGHLIGHTS.map((item) => (
              <div key={item.label} className="flex flex-col gap-1">
                <dt className="text-ui font-medium text-foreground">{item.label}</dt>
                <dd className="m-0 text-xs text-muted-foreground">{item.detail}</dd>
              </div>
            ))}
          </dl>
        </div>

        <figure
          style={{ '--stagger-index': 2 } as CSSProperties}
          className="motion-page-enter motion-stagger m-0 hidden min-w-0 flex-col sm:flex"
        >
          <Card variant="panel" density="none" className="p-2.5">
            {heroImage ? (
              <ShowcaseFrame
                file={heroImage.file}
                label={heroImage.label}
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
          </Card>
        </figure>
      </LandingFrame>

      {/* 窄屏横向作品条：容器自身横向滚动，页面零横向溢出。 */}
      <div className="mt-8 overflow-x-auto px-4 pb-10 sm:hidden">
        <ul className="m-0 flex w-max list-none gap-3 p-0">
          {strip.map((entry) =>
            entry.item ? (
              <li key={entry.file} className={cn('flex shrink-0 flex-col gap-2', entry.widthClass)}>
                <ShowcaseFrame
                  file={entry.item.file}
                  label={entry.item.label}
                  className="h-56 w-full rounded-card border border-border shadow-soft"
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
