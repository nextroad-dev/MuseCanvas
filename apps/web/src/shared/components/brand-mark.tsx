import { StaticImage } from '@/shared/components/static-image'
import { cn } from '@/shared/lib/cn'

/** 品牌飘带标志原始比例（40 × 19）。 */
const MARK_RATIO = 40 / 19

export interface BrandMarkProps {
  /** `mark` 仅图形；`lockup` 图形 + 文字；`wordmark` 仅文字。 */
  variant?: 'mark' | 'lockup' | 'wordmark'
  /** 图形宽度（px，默认 36）；高度按 40 × 19 比例推导。 */
  size?: number
  /** 直接指定图形高度（px），宽度按比例推导。 */
  height?: number
  /** 文字是否使用 display 字体。 */
  displayFont?: boolean
  /** 是否随视口流式缩放（用于公共顶栏 lockup）。 */
  responsive?: boolean
  className?: string
}

/**
 * 品牌标志：基于 `StaticImage` 渲染原生 `<img>`，零 `next/image` 依赖。
 */
export function BrandMark({
  variant = 'lockup',
  size = 36,
  height,
  displayFont = false,
  responsive = false,
  className,
}: BrandMarkProps) {
  const width = height ? Math.round(height * MARK_RATIO) : size
  const pixelHeight = height ?? Math.round(width / MARK_RATIO)

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center',
        responsive ? 'gap-[clamp(8px,0.75vw,10px)]' : 'gap-2.5',
        className,
      )}
    >
      {variant !== 'wordmark' ? (
        <StaticImage
          src="/brand/brand-mark.png"
          alt={variant === 'lockup' ? '' : 'MuseCanvas'}
          width={width}
          height={pixelHeight}
          className={cn('block shrink-0 object-contain', responsive && 'aspect-[40/19]')}
          style={
            responsive
              ? { height: 'clamp(16px, 1.3vw, 20px)', width: 'auto' }
              : { width, height: pixelHeight }
          }
        />
      ) : null}
      {variant !== 'mark' ? (
        <span
          className={cn(
            'font-semibold tracking-tight text-foreground',
            responsive ? 'text-brand' : 'text-compact',
            displayFont && 'font-display',
          )}
        >
          MuseCanvas
        </span>
      ) : null}
    </span>
  )
}
