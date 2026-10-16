import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { BrandMark } from '@/shared/components/brand-mark'
import { ThemeToggle } from '@/shared/components/ui/theme-toggle'
import { SHOWCASE_WORKS, showcaseSrc } from '@/shared/lib/showcase'

/**
 * Frame for the `(auth)` routes. It stays a server component: the session
 * pre-check lives in `login/page.tsx`, and nothing here reads cookies.
 *
 * Two-column board (login design 06): the left column owns the top bar and the
 * centered 400px form; the right column is a tonal panel with a works collage.
 * The right column drops out below the `md` breakpoint (960px).
 */

/**
 * 登录页右侧作品拼图：与落地页作品条同一批素材（`public/showcase/`）。
 * 素材缺失时对应格子渲染 token 色占位，不报错。格内不显示任何文字
 * （画幅比例与提示词都不出现），保持纯视觉。
 */
const SHOWCASE_TILES = [
  { file: SHOWCASE_WORKS[0].file, span: 'row-span-2' },
  { file: SHOWCASE_WORKS[1].file, span: 'col-span-2' },
  { file: SHOWCASE_WORKS[2].file, span: '' },
  { file: SHOWCASE_WORKS[3].file, span: 'row-span-2' },
  { file: SHOWCASE_WORKS[4].file, span: 'col-span-2' },
] as const

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas text-foreground antialiased">
      <div className="flex min-h-screen flex-wrap">
        <div className="flex min-w-0 flex-[1_1_520px] flex-col px-4 sm:px-8">
          <header className="flex h-[var(--layout-header)] items-center justify-between">
            <Link href="/" aria-label="返回 MuseCanvas 首页" className="flex items-center gap-2 rounded-control">
              <BrandMark variant="mark" priority className="h-5 w-auto" />
              <span className="text-sm font-medium">MuseCanvas</span>
            </Link>
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <Link
                href="/"
                className="rounded-control px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                返回首页
              </Link>
            </div>
          </header>

          <main className="motion-page-enter flex flex-1 items-center justify-center py-12">
            <div className="flex w-full max-w-[400px] flex-col gap-7">
              {children}

              <p className="text-xs text-muted-foreground [text-wrap:pretty]">
                登录即代表你已阅读并同意
                <Link href="/terms" className="rounded-control underline underline-offset-2 hover:text-foreground">
                  用户协议
                </Link>
                与
                <Link href="/privacy" className="rounded-control underline underline-offset-2 hover:text-foreground">
                  隐私政策
                </Link>
                。
              </p>
            </div>
          </main>
        </div>

        <aside aria-label="作品示例" className="hidden min-h-[520px] min-w-0 flex-[1_1_520px] p-4 md:block">
          <div className="flex h-full flex-col gap-4 overflow-hidden rounded-panel bg-tonal p-6">
            <div aria-hidden="true" className="grid min-h-0 flex-1 grid-cols-3 grid-rows-3 gap-3">
              {SHOWCASE_TILES.map((tile) => {
                const src = showcaseSrc(tile.file)
                return (
                  <div
                    key={tile.file}
                    className={`relative min-h-0 overflow-hidden rounded-card bg-surface ${tile.span}`}
                  >
                    {src ? (
                      <Image
                        src={src}
                        alt=""
                        fill
                        sizes="(max-width: 1280px) 30vw, 400px"
                        loading="lazy"
                        className="object-cover"
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>
            <p className="text-sm text-muted-foreground">写下画面，剩下的交给工作台。</p>
          </div>
        </aside>
      </div>
    </div>
  )
}
