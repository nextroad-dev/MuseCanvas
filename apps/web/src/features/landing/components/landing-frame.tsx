import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

export interface LandingFrameProps {
  children: ReactNode
  className?: string
}

/**
 * 落地页内容栏：设计稿 1280px + 16/24/40px 递进边距。
 * 各 section 的全宽底色 / 边框放在 section 上，内容统一收敛到这里。
 */
export function LandingFrame({ children, className }: LandingFrameProps) {
  return (
    <div className={cn('mx-auto box-border w-full max-w-[80rem] px-4 sm:px-6 md:px-10', className)}>
      {children}
    </div>
  )
}
