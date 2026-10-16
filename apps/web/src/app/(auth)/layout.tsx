import Link from 'next/link'
import type { ReactNode } from 'react'
import { BrandMark } from '@/shared/components/brand-mark'
import { ThemeToggle } from '@/shared/components/ui/theme-toggle'

/**
 * Frame for the `(auth)` routes. It stays a server component: the session
 * pre-check lives in `login/page.tsx`, and nothing here reads cookies.
 *
 * Two-column board (login design 06): the left column owns the top bar and the
 * centered 400px form; the right column is a tonal panel with a placeholder
 * works collage (`public/showcase/*` is still owner-supplied, so every tile is
 * a token-colored stand-in that never errors when the assets are missing). The
 * right column drops out below the `md` breakpoint (960px).
 */
const SHOWCASE_TILES = [
  { label: '作品图 · 3:4', span: 'row-span-2' },
  { label: '作品图 · 16:9', span: 'col-span-2' },
  { label: '作品图 · 1:1', span: '' },
  { label: '作品图 · 9:16', span: 'row-span-2' },
  { label: '作品图 · 4:3', span: 'col-span-2' },
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
              {SHOWCASE_TILES.map((tile) => (
                <div
                  key={tile.label}
                  className={`flex min-h-0 items-end rounded-card bg-surface p-3 ${tile.span}`}
                >
                  <span className="font-mono text-caption text-muted-foreground">{tile.label}</span>
                </div>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">写下画面，剩下的交给工作台。</p>
          </div>
        </aside>
      </div>
    </div>
  )
}
