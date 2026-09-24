import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'

interface LegalShellProps {
  title: string
  updatedAt: string
  children: ReactNode
}

export function LegalShell({ title, updatedAt, children }: LegalShellProps) {
  return (
    <div className="min-h-screen bg-canvas text-foreground antialiased">
      {/* Opaque sticky bar: no blur, no transparency */}
      <nav className="sticky top-0 z-50 border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-[68ch] items-center justify-between gap-3 px-4 sm:h-16 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="flex min-w-0 items-center rounded-[var(--radius-control)]"
            aria-label="返回 MuseCanvas 首页"
          >
            <img
              src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/03_wordmark_transparent_trimmed.png"
              alt="MuseCanvas"
              className="h-5 w-auto sm:h-6"
            />
          </Link>
          <Link
            href="/login"
            aria-label="返回登录"
            className="inline-flex min-h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-control)] px-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">返回登录</span>
          </Link>
        </div>
      </nav>

      {/* Reading measure stays between 60 and 72 characters; page margins are
          16 / 24 / 32px across phone, tablet and desktop */}
      <main className="mx-auto max-w-[68ch] px-4 py-10 sm:px-6 sm:py-12 lg:px-8 lg:py-16">
        <h1 className="text-title font-normal leading-[1.25] text-foreground [text-wrap:balance]">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          最后更新：<span className="font-mono tabular-nums whitespace-nowrap">{updatedAt}</span>
        </p>

        <div className="mt-8 space-y-8 sm:mt-10 sm:space-y-10 [&_h2]:[text-wrap:balance] [&_h2]:text-subtitle [&_h2]:font-normal [&_h2]:leading-[1.4] [&_h2]:text-foreground [&_p]:mt-3 [&_p]:text-base [&_p]:leading-[1.59] [&_p]:[text-wrap:pretty] [&_p]:[overflow-wrap:break-word] [&_p]:text-muted-foreground [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ul]:text-base [&_ul]:leading-[1.59] [&_ul]:text-muted-foreground [&_li]:[text-wrap:pretty] [&_li]:[overflow-wrap:break-word] [&_strong]:font-medium [&_strong]:text-foreground">
          {children}
        </div>
      </main>
    </div>
  )
}
