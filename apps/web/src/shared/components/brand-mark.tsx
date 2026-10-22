import { cn } from '@/shared/lib/cn'

export interface BrandMarkProps {
  /**
   * `wordmark`: horizontal text mark (default for headers and auth).
   * `monochrome`: black mark for footer / compact placement.
   * `primary`: color ribbon logo.
   * `mark`: square-ish standalone brand mark (public/brand/brand-mark.png).
   */
  variant?: 'wordmark' | 'monochrome' | 'primary' | 'mark'
  className?: string
  priority?: boolean
}

const BRAND_PATHS = {
  primary: '/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/01_primary_logo_transparent_trimmed.png',
  wordmark: '/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/03_wordmark_transparent_trimmed.png',
  monochrome: '/brand/musecanvas_flow_ribbon_final_pack/03_transparent_trimmed_png/04_monochrome_logo_transparent_trimmed.png',
  mark: '/brand/brand-mark.png',
} as const

/** Intrinsic sizes pin the layout box before the bytes arrive (no CLS). */
const BRAND_DIMENSIONS = {
  primary: { width: 1105, height: 665 },
  wordmark: { width: 1277, height: 327 },
  monochrome: { width: 932, height: 586 },
  mark: { width: 780, height: 370 },
} as const

/**
 * Theme-aware brand mark component for MuseCanvas.
 *
 * Light wordmark keeps the original brand colors. Dark headers use the existing
 * monochrome asset; only that monochrome image is filtered, never the green logo.
 * Images inherit the frame height supplied by the consumer.
 */
export function BrandMark({
  variant = 'wordmark',
  className,
  priority = false,
}: BrandMarkProps) {
  const dimensions = BRAND_DIMENSIONS[variant]
  return (
    <span className={cn('inline-flex h-7 shrink-0 items-center select-none', className)}>
      <img
        src={BRAND_PATHS[variant]}
        alt="MuseCanvas"
        width={dimensions.width}
        height={dimensions.height}
        className={cn(
          'h-full w-auto max-w-full object-contain',
          variant === 'wordmark' && 'dark:hidden',
          variant === 'monochrome' && 'dark:brightness-0 dark:invert',
        )}
        loading={priority ? 'eager' : 'lazy'}
      />
      {variant === 'wordmark' && (
        <img
          src={BRAND_PATHS.monochrome}
          alt="MuseCanvas"
          width={BRAND_DIMENSIONS.monochrome.width}
          height={BRAND_DIMENSIONS.monochrome.height}
          className="hidden h-full w-auto max-w-full object-contain brightness-0 invert dark:block"
          loading={priority ? 'eager' : 'lazy'}
        />
      )}
    </span>
  )
}
