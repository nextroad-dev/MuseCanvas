import type { ReactNode } from 'react'
import { StaticImage } from '@/shared/components/static-image'
import { cn } from '@/shared/lib/cn'
import { SHOWCASE_ITEMS, showcasePrompt, showcaseSrc } from '@/shared/lib/showcase'

export interface ShowcaseFrameProps {
  /** `public/showcase/` 下的文件名。 */
  file: string
  /** 画幅标签（`3:4` 等），用于缺图占位与回退 alt。 */
  label: string
  /** 形状与尺寸由调用方控制（aspect-ratio / 固定高度 / 网格填充）。 */
  className?: string
  /** 重复出现的装饰性配图传 true，读屏跳过。 */
  decorative?: boolean
  /** 首屏 LCP 图片传 true，提升取图优先级并立即加载。 */
  priority?: boolean
  /** 父容器带 `group` 时开启轻柔悬停放大。 */
  hoverZoom?: boolean
  /** 叠在图片上的内容（作品名渐变条、画幅徽标等）。 */
  children?: ReactNode
}

/**
 * 作品图框：使用 `StaticImage`（原生 `<img>`）撑满调用方形状。
 * 显式透传素材固有 `width`/`height` 与绝对定位 `object-cover`，兼顾零 CLS 与网格稳定性；
 * 缺图时回落 `bg-tonal` 占位。
 */
export function ShowcaseFrame({
  file,
  label,
  className,
  decorative = false,
  priority = false,
  hoverZoom = false,
  children,
}: ShowcaseFrameProps) {
  const src = showcaseSrc(file)
  const meta = SHOWCASE_ITEMS.find((item) => item.file === file)

  return (
    <div className={cn('relative overflow-hidden bg-tonal', className)}>
      {src ? (
        <StaticImage
          src={src}
          alt={decorative ? '' : showcasePrompt(file, label)}
          width={meta?.width}
          height={meta?.height}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'low'}
          decoding={priority ? 'sync' : 'async'}
          className={cn(
            'absolute inset-0 size-full object-cover',
            hoverZoom &&
              'transition-transform duration-[var(--motion-spring-gentle)] ease-spring-gentle group-hover:scale-[1.02] motion-reduce:transition-none',
          )}
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-full items-center justify-center font-mono text-xs text-decorative-muted"
        >
          {label}
        </span>
      )}
      {children}
    </div>
  )
}
