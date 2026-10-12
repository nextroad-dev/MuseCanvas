'use client'

import { useState } from 'react'
import { UserCircleIcon as UserRound } from '@phosphor-icons/react'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { controlSquare, iconSize } from './size'

/**
 * The spec's size ladder (components.md Avatar row): xs 24 / sm 32 / md 40 /
 * lg 48 / xl 64. The letter grows with the box (12px at xs, 14px through md, then
 * 16 / 18px). The four smaller boxes ARE the control ladder, so they reference it
 * instead of repeating its pixels; `xl` is the one literal here because the control
 * ladder stops at 56.
 */
const SIZE_CLASS = {
  xs: `${controlSquare.xs} text-xs`,
  sm: `${controlSquare.sm} text-sm`,
  md: `${controlSquare.md} text-sm`,
  lg: `${controlSquare.lg} text-base`,
  xl: 'h-16 w-16 text-lg',
} as const

/**
 * Presence dot: a quarter of the avatar's diameter, sitting in the lower-right
 * quadrant. The offset keeps it *inside* the circle — the surface clips, so a
 * dot pushed into the corner would be cut in half by the round edge.
 */
const DOT_CLASS = {
  xs: 'size-1.5 right-[3px] bottom-[3px]',
  sm: 'size-2 right-1 bottom-1',
  md: 'size-2.5 right-[5px] bottom-[5px]',
  lg: 'size-3 right-1.5 bottom-1.5',
  xl: 'size-4 right-2 bottom-2',
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
  /** The dot's own accessible name (spec: 状态点有独立可访问名称). */
  label: string
}

interface AvatarSharedProps {
  size?: AvatarSize
  /** First-letter fallback source — a name or e-mail; only its first glyph shows. */
  initial?: string
  /** Last resort when there is neither an image nor an initial. */
  fallbackIcon?: PhosphorIcon
  /** Presence dot, always with its own label; the colour is never the only clue. */
  status?: AvatarStatus
  /**
   * `tonal` (default) paints the circle. `transparent` hands the surface back to a
   * containing control — an avatar doubling as a menu trigger, where the button
   * owns the hover / pressed / open paint.
   */
  surface?: 'tonal' | 'transparent'
  /** For a row where adjacent text already names the person: hides the glyph. */
  decorative?: boolean
  className?: string
}

export type AvatarProps = AvatarSharedProps &
  (
    | {
        /** Image source. Supplying one makes `alt` required. */
        src: string
        /** Who this is (`张三的头像`) — never the bare word `头像` (a11y). */
        alt: string
      }
    | { src?: undefined; alt?: string }
  )

/**
 * Avatar (components.md 展示与内容 → Avatar): circular, degrading in the spec's
 * order — image, then first letter, then icon. An image that fails falls back at
 * runtime instead of leaving a broken frame, and the prop type makes "an avatar
 * image without alt" unrepresentable.
 *
 * The letter rides on `bg-tonal` with `text-foreground` (#1a1a18 on #efefe9,
 * ≈13:1): the spec wants the fallback surface derived from tonal *while keeping
 * the 3:1 a graphic needs*, which a muted letter on tonal (≈2.9:1) would miss.
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
  // A new `src` is a new identity: the failure is remembered per URL, so the
  // caller can re-sign an expired one and the load cycle starts over.
  const showImage = Boolean(src) && failedSrc !== src
  const shown: 'image' | 'initial' | 'icon' = showImage ? 'image' : letter ? 'initial' : 'icon'

  return (
    <span
      aria-hidden={decorative ? true : undefined}
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
          // No lazy loading: an avatar is a small above-the-fold face, and a late
          // paint would flash its own fallback for a frame.
          className="h-full w-full object-cover"
          onError={() => setFailedSrc(src ?? null)}
        />
      ) : shown === 'initial' ? (
        <span aria-hidden="true" className="font-medium">
          {letter}
        </span>
      ) : (
        <Icon weight="duotone" aria-hidden="true" className={`${iconSize.sm} text-muted-foreground`} />
      )}

      {status ? (
        <>
          <span
            aria-hidden="true"
            className={cn('absolute rounded-pill', DOT_CLASS[size], DOT_TONE[status.tone])}
          />
          <span className="sr-only">{status.label}</span>
        </>
      ) : null}
    </span>
  )
}
