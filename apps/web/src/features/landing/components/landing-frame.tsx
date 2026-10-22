import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

/**
 * Landing container from the design mock: a 1280px column with 40px gutters from
 * `md`. Local to the landing page; `ContentFrame` (legal, workspace) keeps its own
 * 1440px contract, and no shared token changes.
 */
export function LandingFrame({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('mx-auto box-border w-full max-w-[80rem] px-4 sm:px-6 md:px-10', className)}>
      {children}
    </div>
  )
}
