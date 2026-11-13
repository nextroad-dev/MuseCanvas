import type { ReactNode } from 'react'
import Image from 'next/image'
import { cn } from '@/shared/lib/cn'
import { showcasePrompt, showcaseSrc } from '@/shared/lib/showcase'

export interface ShowcaseFrameProps {
  /** `public/showcase/` 下的文件名。 */
  file: string
  /** 画幅标签（`3:4` 等），只在缺图占位与回退 alt 里使用。 */
  label: string
  /** 形状与尺寸由调用方给（aspect-ratio / 固定高度）。 */
  className?: string
  sizes?: string
  /** 重复出现的配图传 true，读屏跳过。 */
  decorative?: boolean
  /** 首屏 LCP 图片传 true，让浏览器提前取图。 */
  priority?: boolean
  /** 叠在图片上的内容（作品名渐变条等）。 */
  children?: ReactNode
}

/**
 * 作品图框：`next/image` 撑满调用方给的形状，`object-cover` 裁切。
 * 找不到素材地址时渲染 `bg-tonal` 占位，所以缺图也不会把版式撑坏。
 */
export function ShowcaseFrame({
  file,
  label,
  className,
  sizes = '(max-width: 768px) 100vw, 50vw',
  decorative = false,
  priority = false,
  children,
}: ShowcaseFrameProps) {
  const src = showcaseSrc(file)

  return (
    <div className={cn('relative overflow-hidden bg-tonal', className)}>
      {src ? (
        <Image
          src={src}
          alt={decorative ? '' : showcasePrompt(file, label)}
          fill
          sizes={sizes}
          priority={priority}
          fetchPriority={priority ? 'high' : 'low'}
          className="object-cover"
        />
      ) : (
        <span aria-hidden="true" className="flex h-full w-full items-center justify-center font-mono text-xs text-decorative-muted">
          {label}
        </span>
      )}
      {children}
    </div>
  )
}
