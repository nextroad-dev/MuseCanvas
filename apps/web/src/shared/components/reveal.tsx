import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

export interface RevealProps {
  children: ReactNode
  className?: string
}

/**
 * 滚动揭示：首屏之外的分节在进入视口时淡入上移。
 *
 * 纯 CSS，且只做「增强」：`.motion-scroll-reveal` 仅在浏览器支持
 * `animation-timeline: view()` 且未要求 reduced-motion 时存在，其余情况
 * 区块就是它的最终可见态（fail-visible），因此无 JS、旧浏览器都不会藏内容。
 * 首屏（hero）不要包：那是加载即入场的区块，滚动揭示会在首帧留下半透明。
 */
export function Reveal({ children, className }: RevealProps) {
  return <div className={cn('motion-scroll-reveal', className)}>{children}</div>
}
