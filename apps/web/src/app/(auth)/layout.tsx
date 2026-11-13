import type { ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'

import { BrandMark } from '@/shared/components/brand-mark'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { SHOWCASE_ITEMS } from '@/shared/lib/showcase'

/**
 * `(auth)` 路由的外框（设计画板 06）：`flex-wrap` 两栏。
 *
 * 左列：56px 顶栏（品牌 + 返回首页）+ 居中表单（max 400px）。
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
      <section className="flex min-w-0 flex-1 basis-[520px] flex-col px-8">
        <header className="flex h-[var(--layout-header)] shrink-0 items-center justify-between">
          <Link
            href={APP_ROUTES.home}
            aria-label="返回 MuseCanvas 首页"
            className="flex items-center gap-2 rounded-control"
          >
            <BrandMark variant="mark" height={19} />
            <span className="text-compact font-medium text-foreground">MuseCanvas</span>
          </Link>
          <Link
            href={APP_ROUTES.home}
            className="rounded-control px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            返回首页
          </Link>
        </header>

        <main className="motion-page-enter flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-[400px]">{children}</div>
        </main>
      </section>

      <aside
        aria-label="作品示例"
        className="hidden min-h-[520px] min-w-0 flex-1 basis-[520px] p-4 md:flex"
      >
        <div className="flex w-full flex-1 flex-col overflow-hidden rounded-panel bg-tonal p-6">
          <div className="grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-cols-3 gap-3">
            {COLLAGE_CELLS.map(({ index, className }) => {
              const item = SHOWCASE_ITEMS[index]
              return (
                <div
                  key={index}
                  className={cn('relative min-h-0 overflow-hidden rounded-control bg-surface', className)}
                >
                  {item?.src ? (
                    <Image
                      src={item.src}
                      alt=""
                      fill
                      sizes="(max-width: 1536px) 30vw, 25vw"
                      priority={index === 0}
                      className="object-cover"
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      </aside>
    </div>
  )
}
