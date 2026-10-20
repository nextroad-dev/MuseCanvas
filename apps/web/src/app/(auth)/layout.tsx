import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { BrandMark } from '@/shared/components/brand-mark'
import { cn } from '@/shared/lib/cn'
import { SHOWCASE_WORKS, showcaseSrc } from '@/shared/lib/showcase'

/**
 * Frame for the `(auth)` routes. It stays a server component: the session
 * pre-check lives in `login/page.tsx`, and nothing here reads cookies.
 *
 * Two-column board matching the login design: the left column owns the top bar and
 * the centered auth form; the right column is a tonal panel with a works collage.
 * The right column drops out below `lg`.
 */

/**
 * Collage cells in design order. The footprint follows each cell's aspect ratio
 * (3:4 and 9:16 span two rows, 16:9 and 4:3 span two columns, 1:1 takes one cell);
 * the index keeps the existing real showcase images.
 */
const SHOWCASE_CELLS = [
  { index: 3, className: 'row-span-2' },
  { index: 1, className: 'col-span-2' },
  { index: 2, className: '' },
  { index: 0, className: 'row-span-2' },
  { index: 4, className: 'col-span-2' },
] as const

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas text-foreground antialiased">
      <div className="flex min-h-screen flex-col gap-6 p-4 lg:flex-row lg:gap-8 lg:p-7">
        <section className="flex w-full flex-1 flex-col justify-between px-8 py-3 lg:basis-[520px] lg:py-4">
          <header className="flex h-[var(--layout-header)] items-center justify-between pt-1">
            <Link href="/" aria-label="返回 MuseCanvas 首页" className="flex items-center gap-2 rounded-control">
              <BrandMark variant="mark" priority className="h-[19px]" />
              <span className="text-[15px] font-medium text-foreground">MuseCanvas</span>
            </Link>
            <Link
              href="/"
              className="rounded-control px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              返回首页
            </Link>
          </header>

          <main className="motion-page-enter mx-auto my-auto flex w-full max-w-[400px] flex-col py-12 lg:py-0">
            {children}
          </main>

          <footer className="select-none pb-1 text-xs text-transparent" aria-hidden="true">
            MuseCanvas © 2025
          </footer>
        </section>

        <aside aria-label="作品示例" className="hidden min-h-[520px] min-w-0 p-4 lg:flex lg:flex-1 lg:basis-[520px]">
          <div className="flex h-full min-h-0 w-full flex-col gap-4 overflow-hidden rounded-panel bg-tonal p-6">
            <div className="grid min-h-0 flex-1 grid-cols-3 auto-rows-[minmax(0,1fr)] gap-3">
              {SHOWCASE_CELLS.map(({ index, className }) => {
                const src = showcaseSrc(SHOWCASE_WORKS[index].file)
                return (
                  <div key={index} className={cn('relative min-h-0 overflow-hidden rounded-card bg-surface', className)}>
                    {src ? (
                      <Image
                        src={src}
                        alt=""
                        fill
                        sizes="(max-width: 1280px) 30vw, 25vw"
                        loading="lazy"
                        className="object-cover"
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>
            <p className="text-[13px] text-muted-foreground">写下画面，剩下的交给工作台。</p>
          </div>
        </aside>
      </div>
    </div>
  )
}
