import { cn } from '@/shared/lib/cn'

/** 品牌飘带标志的原始比例（设计稿 40 × 19）。 */
const MARK_RATIO = 40 / 19

export interface BrandMarkProps {
  /** `mark` 只有图形；`lockup` 图形 + "MuseCanvas" 文字（站点导航 / 页脚使用）。 */
  variant?: 'mark' | 'lockup'
  /** 图形宽度（px，默认 40）；高度按 40 × 19 比例推导。 */
  size?: number
  /** 兼容写法：直接给图形高度（px），宽度按比例推导。 */
  height?: number
  /** 文字部分是否使用衬线字体（落地页深色收尾区）。 */
  displayFont?: boolean
  /** 是否随视口流式缩放（用于顶栏品牌 lockup）。 */
  responsive?: boolean
  className?: string
}

/**
 * 品牌标志。
 *
 * 用普通 `<img>` 而不是 `next/image`：本站图片全部是本地固定素材，且生产镜像没有
 * 安装 `sharp`，`next/image` 的默认优化器会在 `next start` 下 500。仍显式给
 * `width`/`height`（首屏前就占好位），因此不会产生 CLS。
 */
export function BrandMark({
  variant = 'lockup',
  size = 40,
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
        'inline-flex items-center',
        responsive ? 'gap-[clamp(8px,0.75vw,11px)]' : 'gap-2.5',
        className,
      )}
    >
      <img
        src="/brand/brand-mark.png"
        alt={variant === 'lockup' ? '' : 'MuseCanvas'}
        width={width}
        height={pixelHeight}
        decoding="async"
        className={cn('block shrink-0 object-contain', responsive && 'aspect-[40/19]')}
        style={
          responsive
            ? { height: 'clamp(16px, 1.35vw, 21px)', width: 'auto' }
            : { width, height: pixelHeight }
        }
      />
      {variant === 'lockup' ? (
        <span
          className={cn(
            'text-foreground',
            responsive ? 'text-brand' : 'text-base font-semibold',
            displayFont && 'font-display',
          )}
        >
          MuseCanvas
        </span>
      ) : null}
    </span>
  )
}
