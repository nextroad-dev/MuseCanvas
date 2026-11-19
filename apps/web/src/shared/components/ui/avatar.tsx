'use client'

import { useState } from 'react'
import { UserCircleIcon as UserRound } from '@phosphor-icons/react'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { controlSquare, iconSize } from './size'

/** 尺寸阶梯：xs 28 / sm 32 / md 36 / lg 44 / xl 64，前四档直接复用 4 档控件阶梯。 */
const SIZE_CLASS = {
  xs: `${controlSquare.xs} text-xs`,
  sm: `${controlSquare.sm} text-ui`,
  md: `${controlSquare.md} text-sm`,
  lg: `${controlSquare.lg} text-base`,
  xl: 'size-16 text-lg',
} as const

const DOT_CLASS = {
  xs: 'size-1.5 right-[3px] bottom-[3px]',
  sm: 'size-2 right-1 bottom-1',
  md: 'size-2 right-1 bottom-1',
  lg: 'size-2.5 right-1.5 bottom-1.5',
  xl: 'size-3.5 right-2 bottom-2',
} as const

const DOT_TONE = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-neutral-status',
} as const

export type AvatarSize = keyof typeof SIZE_CLASS

export interface AvatarStatus {
  tone: keyof typeof DOT_TONE
  /** The dot's own accessible name: state is never colour-only. */
  label: string
}

interface AvatarSharedProps {
  size?: AvatarSize
  /** First-letter fallback source — a name or e-mail; only its first glyph shows. */
  initial?: string
  /** Last resort when there is neither an image nor an initial. */
  fallbackIcon?: PhosphorIcon
  /** Presence dot, always with its own label. */
  status?: AvatarStatus
  /** `tonal` (default) paints the circle; `transparent` lets a parent control own the paint. */
  surface?: 'tonal' | 'transparent'
  /** Hides the glyph for a row whose adjacent text already names the person. */
  decorative?: boolean
  className?: string
}

export type AvatarProps = AvatarSharedProps &
  (
    | {
        /** Image source. Supplying one makes `alt` required. */
        src: string
        /** Who this is (`张三的头像`) — never the bare word `头像`. */
        alt: string
      }
    | { src?: undefined; alt?: string }
  )

/**
 * 头像：圆形，按 图片 → 首字母 → 图标 降级；图片加载失败时自动回退，不留破图。
 */
export function Avatar({
  src,
  alt,
  initial,
  fallbackIcon: Icon = UserRound,
  status,
  size = 'md',
  surface = 'tonal',
  decorative,
  className,
}: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const letter = (initial ?? '').trim().charAt(0).toUpperCase()
  const showImage = Boolean(src) && failedSrc !== src
  const shown: 'image' | 'initial' | 'icon' = showImage ? 'image' : letter ? 'initial' : 'icon'

  return (
    <span
      aria-hidden={decorative || undefined}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-pill leading-none',
        surface === 'tonal' && 'bg-tonal text-foreground',
        SIZE_CLASS[size],
        className,
      )}
    >
      {shown === 'image' ? (
        <img
          src={src}
          alt={alt}
          className="size-full object-cover"
          onError={() => setFailedSrc(src ?? null)}
        />
      ) : shown === 'initial' ? (
        <span aria-hidden="true" className="font-medium">
          {letter}
        </span>
      ) : (
        <Icon weight="duotone" aria-hidden="true" className={cn(iconSize.sm, 'text-muted-foreground')} />
      )}

      {status ? (
        <>
          <span aria-hidden="true" className={cn('absolute rounded-pill', DOT_CLASS[size], DOT_TONE[status.tone])} />
          <span className="sr-only">{status.label}</span>
        </>
      ) : null}
    </span>
  )
}
