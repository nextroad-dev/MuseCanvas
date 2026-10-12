import Link from 'next/link'
import type { ReactNode } from 'react'
import { BrandMark } from '@/shared/components/brand-mark'
import { ThemeToggle } from '@/shared/components/ui/theme-toggle'
import { ContentFrame } from '@/shared/components/content-frame'

/**
 * Frame for the `(auth)` routes. It stays a server component: the session
 * pre-check lives in `login/page.tsx`, and nothing here reads cookies.
 *
 * The page is the canvas itself, with one floating panel for the form. Only that
 * panel carries a shadow; the header is a single rule and the footer is plain text.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-foreground antialiased">
      <header className="border-b border-border bg-surface">
        <ContentFrame className="flex h-[var(--layout-header)] items-center justify-between">
          <Link href="/" aria-label="返回 MuseCanvas 首页" className="flex items-center rounded-control">
            <BrandMark variant="wordmark" priority className="h-6 w-auto" />
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link
              href="/"
              className="rounded-control px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              返回首页
            </Link>
          </div>
        </ContentFrame>
      </header>

      <main className="motion-page-enter flex flex-1 flex-col items-center justify-center px-4 py-12 sm:py-16">
        <div className="w-full max-w-dialog-narrow rounded-panel bg-surface p-6 shadow-floating sm:p-8">
          {children}
        </div>

        <p className="mt-8 max-w-dialog-narrow text-center text-sm text-muted-foreground [text-wrap:pretty]">
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
      </main>

      <footer className="py-6 text-center text-xs text-muted-foreground">&copy; 2026 MuseCanvas</footer>
    </div>
  )
}
