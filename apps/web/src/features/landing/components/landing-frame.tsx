import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

export interface LandingFrameProps {
  children: ReactNode
  className?: string
}

/**
 * 落地页内容栏：与 `PublicShell` / `PublicHeader` 共享 `--container-content`（1280px）
 * 及 16/24/40px 响应式水平内边距。各分节的全宽底色与分隔线放在 `<section>` 上。
 */
export function LandingFrame({ children, className }: LandingFrameProps) {
  return (
    <div
      className={cn(
        'mx-auto box-border w-full max-w-[var(--container-content)] px-4 sm:px-6 md:px-10',
        className,
      )}
    >
      {children}
    </div>
  )
}
