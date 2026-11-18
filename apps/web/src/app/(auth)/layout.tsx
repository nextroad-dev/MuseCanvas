import type { ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { ArrowLeftIcon, SparkleIcon } from '@phosphor-icons/react/ssr'

import { BrandMark } from '@/shared/components/brand-mark'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { SHOWCASE_ITEMS } from '@/shared/lib/showcase'

/**
 * `(auth)` 路由的外框（设计画板 06）：`flex-wrap` 两栏。
 *
 * 左列：56px 顶栏（品牌 + 返回首页）+ 居中工作室卡片（max 420px）。
 * 右列：`aside` 内 3 列作品拼图（`public/showcase/*.webp`），<960px（`md` 断点）隐藏。
 * 本文件保持 Server Component：会话预检在 `login/page.tsx`，这里不读 Cookie。
 */

/**
 * 拼图格子：按画幅决定占位——3:4 与 9:16 占两行，16:9 与 4:3 占两列，1:1 占一格。
 * 顺序沿用 `SHOWCASE_ITEMS`（3:4 / 16:9 / 1:1 / 9:16 / 4:3）。
 */
const COLLAGE_CELLS = [
  { index: 0, className: 'row-span-2' },
  { index: 1, className: 'col-span-2' },
  { index: 2, className: '' },
  { index: 3, className: 'row-span-2' },
  { index: 4, className: 'col-span-2' },
] as const

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-wrap bg-canvas text-foreground">
      <section className="flex min-w-0 flex-1 basis-[520px] flex-col px-6 sm:px-8">
        <header className="flex h-[var(--layout-header)] shrink-0 items-center justify-between">
          <Link
            href={APP_ROUTES.home}
            aria-label="返回 MuseCanvas 首页"
            className="flex items-center gap-2.5 rounded-control px-1.5 py-1 transition-colors hover:bg-surface-hover"
          >
            <BrandMark variant="lockup" height={20} responsive />
          </Link>
          <Link
            href={APP_ROUTES.home}
            className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-ui font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <ArrowLeftIcon weight="bold" aria-hidden="true" className="h-3.5 w-3.5" />
            <span>返回首页</span>
          </Link>
        </header>

        <main className="motion-page-enter flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[420px] rounded-panel border border-border bg-surface p-6 shadow-soft sm:p-8">
            {children}
          </div>
        </main>
      </section>

      <aside
        aria-label="作品示例"
        className="hidden min-h-[540px] min-w-0 flex-1 basis-[520px] p-4 md:flex"
      >
        <div className="flex w-full flex-1 flex-col gap-4 overflow-hidden rounded-panel border border-border bg-tonal p-5 shadow-soft">
          <div className="flex items-center justify-between gap-3 px-1">
            <div className="inline-flex items-center gap-2 rounded-pill border border-border bg-surface px-3 py-1 text-ui font-medium text-foreground shadow-soft">
              <SparkleIcon weight="fill" aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
              <span>MuseCanvas Studio</span>
            </div>
            <span className="text-caption font-medium tracking-wide text-muted-foreground">
              精选画幅与提示词示例
            </span>
          </div>

          <div className="grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-cols-3 gap-3">
            {COLLAGE_CELLS.map(({ index, className }) => {
              const item = SHOWCASE_ITEMS[index]
              return (
                <div
                  key={index}
                  className={cn(
                    'group relative min-h-0 overflow-hidden rounded-card border border-border/60 bg-surface shadow-soft',
                    className,
                  )}
                >
                  {item?.src ? (
                    <>
                      <Image
                        src={item.src}
                        alt={item.prompt}
                        fill
                        sizes="(max-width: 1536px) 30vw, 25vw"
                        priority={index === 0}
                        className="object-cover transition-transform group-hover:scale-[1.02]"
                      />
                      <div className="pointer-events-none absolute inset-x-2.5 bottom-2.5 flex items-center justify-between gap-2 rounded-control border border-border/60 bg-surface/90 px-2.5 py-1.5 backdrop-blur-md">
                        <span className="truncate text-caption font-medium text-foreground">
                          {item.prompt}
                        </span>
                        <span className="shrink-0 rounded-pill bg-tonal px-1.5 py-0.5 font-mono text-caption tabular-nums text-muted-foreground">
                          {item.label}
                        </span>
                      </div>
                    </>
                  ) : null}
                </div>
              )
            })}
          </div>

          <p className="px-1 text-ui text-muted-foreground">
            多模型协同生图、结构化提示词模板与云端资产库，专为创作者打造。
          </p>
        </div>
      </aside>
    </div>
  )
}
