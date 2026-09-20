import Link from 'next/link'
import type { ReactNode } from 'react'

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-12 text-foreground">
      <div className="mb-8 flex justify-center">
        <Link href="/" aria-label="返回 MuseCanvas 首页">
          <img
            src="/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/03_wordmark_transparent_trimmed.png"
            alt="MuseCanvas"
            className="h-8 w-auto"
          />
        </Link>
      </div>

      <div className="w-full max-w-md rounded-[var(--radius-panel)] border border-border bg-surface p-6 shadow-sm sm:p-8">
        {children}
      </div>

      <div className="mt-8 text-center text-xs text-muted-foreground">
        <span>登录即代表同意 </span>
        <Link href="/terms" className="underline hover:text-foreground">
          用户协议
        </Link>
        <span> 与 </span>
        <Link href="/privacy" className="underline hover:text-foreground">
          隐私政策
        </Link>
      </div>
    </div>
  )
}
