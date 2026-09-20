'use client'

import { Play, VolumeX } from 'lucide-react'
import type { MediaKind } from '@/shared/types'

export type MediaFrameLayout = 'tile' | 'stage' | 'thumb'

export interface MediaFrameProps {
  src: string
  kind: MediaKind
  alt: string
  /** `tile` = grid cell, `stage` = the large preview, `thumb` = fixed 48x48 rail box. */
  layout: MediaFrameLayout
  durationSeconds?: number
  /** `'16:9'`; only drives `stage`, where an unloaded <video> would otherwise collapse. */
  aspectRatio?: string
  width?: number
  height?: number
  hasAudio?: boolean
  showControls?: boolean
  /** Full class string for the media element. Callers own their exact styling so
   *  swapping in this component never moves existing pixels; omit to use the
   *  per-layout defaults below. */
  className?: string
}

/** Media element classes for still images. `tile`/`thumb` mirror the library grid
 *  and the console history rail; `stage` mirrors the console result grid. */
const IMAGE_CLASS: Record<MediaFrameLayout, string> = {
  tile: 'aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-105',
  stage: 'h-auto w-full object-cover transition-transform duration-300 group-hover:scale-105',
  thumb: 'h-full w-full object-cover',
}

/** Media element classes for video. No hover scale: a paused frame that jumps on
 *  pointer-over reads as a broken player. */
const VIDEO_CLASS: Record<MediaFrameLayout, string> = {
  tile: 'aspect-square w-full object-cover',
  stage: 'h-full w-full bg-surface object-contain',
  thumb: 'h-full w-full object-cover',
}

const WRAPPER_CLASS: Record<MediaFrameLayout, string> = {
  tile: 'relative block w-full',
  stage: 'relative block w-full',
  thumb: 'relative block h-full w-full',
}

/** Chip placement: a 48px rail box cannot fit a floated pill, so there the scrim
 *  becomes a full-width bar pinned to the bottom edge. */
const CHIP_CLASS: Record<'tile' | 'thumb', string> = {
  tile: 'bottom-1 left-1 gap-1 rounded-[var(--radius-control)] px-1.5 py-0.5',
  thumb: 'inset-x-0 bottom-0 gap-0.5 rounded-none px-1 py-px',
}

/**
 * `assets.poster_object_key` has no writer anywhere in the repo, so video
 * thumbnails have no poster to point at. `#t=0.1` is a media fragment resolved by
 * the browser (with `preload="metadata"` it decodes and paints the first frame)
 * and is never part of the request, so signed URLs stay valid.
 */
export function videoPosterSrc(url: string): string {
  return `${url}#t=0.1`
}

/** `0:08` / `1:05`. Empty string when the duration is unknown. */
export function formatDuration(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0) return ''
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

/** CSS `aspect-ratio` for the stage box: real pixels win, then the declared ratio. */
export function stageAspectRatio(
  aspectRatio?: string,
  width?: number,
  height?: number,
): string {
  if (width && height && width > 0 && height > 0) return `${width} / ${height}`
  if (aspectRatio) {
    const parts = aspectRatio.split(/[:/]/).map((part) => part.trim()).filter(Boolean)
    if (parts.length === 2) return `${parts[0]} / ${parts[1]}`
    if (parts.length === 1 && parts[0]) return parts[0]
  }
  return '16 / 9'
}

/** The one img-vs-video decision point shared by the console result grid, the
 *  console history rail and the library. Images render as a bare `<img>` with no
 *  wrapper element so existing markup and layout stay byte-for-byte unchanged. */
export function MediaFrame({
  src,
  kind,
  alt,
  layout,
  durationSeconds,
  aspectRatio,
  width,
  height,
  hasAudio,
  showControls,
  className,
}: MediaFrameProps) {
  if (kind !== 'video') {
    return <img src={src} alt={alt} className={className ?? IMAGE_CLASS[layout]} loading="lazy" />
  }

  const media = (
    <video
      src={videoPosterSrc(src)}
      aria-label={alt}
      className={className ?? VIDEO_CLASS[layout]}
      style={layout === 'stage' ? { aspectRatio: stageAspectRatio(aspectRatio, width, height) } : undefined}
      preload="metadata"
      muted
      playsInline
      controls={showControls === true}
    />
  )

  if (layout === 'stage') return media

  return (
    <div className={WRAPPER_CLASS[layout]}>
      {media}
      {/* Bottom-left duration / mute chip over the functional scrim. */}
      <span
        className={`media-scrim bg-overlay/70 absolute flex items-center justify-start text-foreground-inverse font-mono text-xs tabular-nums ${CHIP_CLASS[layout]}`}
      >
        {hasAudio === false ? (
          <>
            <VolumeX className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only">无声</span>
          </>
        ) : (
          <>
            <Play className="h-3 w-3" aria-hidden="true" />
            <span>{formatDuration(durationSeconds)}</span>
          </>
        )}
      </span>
    </div>
  )
}
