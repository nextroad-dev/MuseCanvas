import type { ImgHTMLAttributes, Ref } from 'react'

export interface StaticImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'> {
  src: string
  alt: string
  ref?: Ref<HTMLImageElement>
}

/**
 * 静态图片薄封装：直接渲染原生 `<img>`，不依赖 `next/image` / `sharp`，
 * 避免自托管精简镜像下 Next 图像优化器 500；配合显式 `width`/`height` 保持零 CLS。
 */
export function StaticImage({
  src,
  alt,
  decoding = 'async',
  ref,
  ...rest
}: StaticImageProps) {
  return <img ref={ref} src={src} alt={alt} decoding={decoding} {...rest} />
}
