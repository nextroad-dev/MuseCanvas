import type { ElementType, HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

export interface ContentFrameProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType
  children: ReactNode
  className?: string
  /**
   * When true, removes the internal horizontal gutters.
   * Useful when an inner component manages gutters directly.
   */
  noGutter?: boolean
}

/**
 * Universal layout frame component for MuseCanvas.
 *
 * Implements the approved site-wide layout contract:
 * - Outer boundary: `w-full max-w-content mx-auto` (capped at 1440px).
 * - Standard gutters: 16px (<640px) -> 24px (sm: 640px-959px) -> 32px (md: >=960px).
 * - SSR safe, directive-free (no 'use client'), no queries or state.
 */
export function ContentFrame({
  as: Component = 'div',
  children,
  className,
  noGutter = false,
  ...rest
}: ContentFrameProps) {
  return (
    <Component
      className={cn(
        'mx-auto w-full max-w-content box-border',
        !noGutter && 'px-4 sm:px-6 md:px-8',
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  )
}
