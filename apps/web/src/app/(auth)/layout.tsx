import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { BrandMark } from '@/shared/components/brand-mark'
import { SHOWCASE_WORKS, showcaseSrc } from '@/shared/lib/showcase'

/**
 * Frame for the `(auth)` routes. It stays a server component: the session
 * pre-check lives in `login/page.tsx`, and nothing here reads cookies.
 *
 * Two-column board matching the reference login design: the left column owns
 * the top bar and the centered auth form; the right column is a tonal panel
 * with a bento-style works collage. The right column drops out below `lg`.
 */

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas text-foreground antialiased">
      <div className="flex min-h-screen flex-col gap-6 p-4 lg:flex-row lg:gap-8 lg:p-7">
        <section className="flex w-full flex-col justify-between px-4 py-3 sm:px-10 lg:w-[46%] lg:px-12 lg:py-4 xl:w-[44%]">
          <header className="flex h-[var(--layout-header)] items-center justify-between pt-1">
            <Link href="/" aria-label="返回 MuseCanvas 首页" className="flex items-center gap-2.5 rounded-control">
              <BrandMark variant="mark" priority className="h-6 w-auto" />
              <span className="text-xl font-medium tracking-tight text-foreground">MuseCanvas</span>
            </Link>
            <Link
              href="/"
              className="rounded-control px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              返回首页
            </Link>
          </header>

          <main className="motion-page-enter mx-auto my-auto flex w-full max-w-[430px] flex-col py-12 lg:py-0">
            {children}
          </main>

          <footer className="select-none pb-1 text-xs text-transparent" aria-hidden="true">
            MuseCanvas © 2025
          </footer>
        </section>

        <aside aria-label="作品示例" className="hidden min-h-[520px] min-w-0 lg:flex lg:w-[54%] xl:w-[56%]">
          <div className="flex h-full min-h-0 w-full flex-col gap-[14px] overflow-hidden rounded-[28px] bg-tonal p-4 shadow-inner sm:p-5">
            <div className="grid min-h-0 flex-1 grid-cols-12 grid-rows-1 gap-[14px]">
              {/* Left: tall portrait */}
              <div className="relative col-span-4 min-h-0 overflow-hidden rounded-card bg-surface">
                {showcaseSrc(SHOWCASE_WORKS[3].file) ? (
                  <Image
                    src={showcaseSrc(SHOWCASE_WORKS[3].file)!}
                    alt=""
                    fill
                    sizes="(max-width: 1280px) 20vw, 25vw"
                    loading="lazy"
                    className="object-cover"
                  />
                ) : null}
              </div>

              {/* Middle column: two stacked images */}
              <div className="col-span-5 flex min-h-0 flex-col gap-[14px]">
                <div className="relative h-[195px] flex-shrink-0 overflow-hidden rounded-card bg-surface">
                  {showcaseSrc(SHOWCASE_WORKS[1].file) ? (
                    <Image
                      src={showcaseSrc(SHOWCASE_WORKS[1].file)!}
                      alt=""
                      fill
                      sizes="(max-width: 1280px) 25vw, 30vw"
                      loading="lazy"
                      className="object-cover"
                    />
                  ) : null}
                </div>
                <div className="relative min-h-0 flex-1 overflow-hidden rounded-card bg-surface">
                  {showcaseSrc(SHOWCASE_WORKS[2].file) ? (
                    <Image
                      src={showcaseSrc(SHOWCASE_WORKS[2].file)!}
                      alt=""
                      fill
                      sizes="(max-width: 1280px) 25vw, 30vw"
                      loading="lazy"
                      className="object-cover"
                    />
                  ) : null}
                </div>
              </div>

              {/* Right: slender portrait */}
              <div className="relative col-span-3 min-h-0 overflow-hidden rounded-card bg-surface">
                {showcaseSrc(SHOWCASE_WORKS[0].file) ? (
                  <Image
                    src={showcaseSrc(SHOWCASE_WORKS[0].file)!}
                    alt=""
                    fill
                    sizes="(max-width: 1280px) 15vw, 20vw"
                    loading="lazy"
                    className="object-cover"
                  />
                ) : null}
              </div>
            </div>

            {/* Bottom: wide card */}
            <div className="relative h-[260px] w-full flex-shrink-0 overflow-hidden rounded-card bg-surface">
              {showcaseSrc(SHOWCASE_WORKS[4].file) ? (
                <Image
                  src={showcaseSrc(SHOWCASE_WORKS[4].file)!}
                  alt=""
                  fill
                  sizes="(max-width: 1280px) 50vw, 55vw"
                  loading="lazy"
                  className="object-cover"
                />
              ) : null}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
