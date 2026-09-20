'use client'

import { useState } from 'react'
import { ImageOff, Play, VolumeX } from 'lucide-react'
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
  /** Worker-derived preview (≈512px WebP / JPEG poster) for this asset. Honoured by
   *  `tile` and `thumb` only — `stage` is the full-size surface, and a thumbnail
   *  there would upscale into mush. For video it becomes `poster`, for an image the
   *  `src`; `src` stays the real media either way, so retry, click-through and
   *  download never see the thumbnail. */
  previewSrc?: string
  /** Full class string for the media element. Callers own their exact styling so
   *  swapping in this component never moves existing pixels; omit to use the
   *  per-layout defaults below. */
  className?: string
  /** Fired once the element has failed against the original `src` too — i.e. after the
   *  internal preview→original retry is spent. A presigned URL expiring is the case
   *  this exists for: the caller can re-sign and hand back a new `src`, and the
   *  identity change resets the load cycle. Omit it and behaviour is unchanged.
   *  Wired only for the decorated (`tile`) layout; `stage`/`thumb` still render the
   *  bare element they always have, with no load states of their own. */
  onMediaError?: () => void
}

/** Media element classes for still images. `tile`/`thumb` mirror the library grid
 *  and the console history rail; `stage` mirrors the console result grid. */
const IMAGE_CLASS: Record<MediaFrameLayout, string> = {
  tile: 'aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-105',
  stage: 'h-auto w-full object-cover transition-transform duration-300 group-hover:scale-105',
  thumb: 'h-full w-full object-cover',
}

/** Media element classes for video. No hover scale: a paused frame that jumps on
 *  pointer-over reads as a broken player. `stage` mirrors the image contract
 *  above — the box is sized from the media's own ratio (the inline
 *  `aspect-ratio` below), so a 16:9 clip no longer stretches into a taller
 *  frame and paints a white band under itself. */
const VIDEO_CLASS: Record<MediaFrameLayout, string> = {
  tile: 'aspect-square w-full object-cover',
  stage: 'h-auto w-full object-contain',
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
 * `assets.poster_object_key` now has a writer (the worker derives a ~512px JPEG
 * poster for video and exposes it as `thumbnailUrl`), so a tile can usually point
 * `poster` at a real image. This is the fallback for the rows that predate that
 * pass, or whose poster derivation failed: `#t=0.1` is a media fragment resolved
 * by the browser (with `preload="metadata"` it decodes and paints the first
 * frame) and is never part of the request, so signed URLs stay valid.
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

/** Load lifecycle of the media element, driven by the browser events below.
 *  `retrying` is the single second chance against the full-size `src` after a
 *  thumbnail 404s (presigned URLs expire); `failed` settles on a static scrim. */
type LoadPhase = 'loading' | 'ready' | 'retrying' | 'failed'

interface LoadState {
  identity: string
  phase: LoadPhase
}

/** `''` for missing/whitespace-only, so an empty `thumbnailUrl` from the API
 *  degrades to "no preview" instead of `<img src="">`. */
function asPreviewUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** The one img-vs-video decision point shared by the console result grid, the
 *  console history rail and the library. Only the library (`tile`) gets the
 *  loading skeleton, so `stage` and `thumb` keep rendering the exact same markup
 *  they did before: a bare `<img>` with no wrapper for images, and for video the
 *  wrapper plus duration chip. */
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
  previewSrc,
  className,
  onMediaError,
}: MediaFrameProps) {
  const isVideo = kind === 'video'
  // `stage` is the full-size surface; a thumbnail there is a downgrade.
  const rawPreview = layout === 'stage' ? undefined : asPreviewUrl(previewSrc)
  // A preview that *is* the original (no thumbnail derived yet) is no preview at
  // all: keeping it would burn the one retry on a request that already failed.
  const preview = rawPreview && rawPreview !== src ? rawPreview : undefined
  const poster = isVideo ? preview : undefined
  const decorated = layout === 'tile'

  const identity = `${kind}|${src}|${preview ?? ''}`
  const [state, setState] = useState<LoadState>({ identity, phase: 'loading' })
  // Source swapped (new asset, thumbnail backfilled, URL re-signed): reset during
  // render rather than in an effect, so no frame ever shows the old element state.
  if (state.identity !== identity) setState({ identity, phase: 'loading' })
  const phase = state.identity === identity ? state.phase : 'loading'

  // A failed preview falls back to the original exactly once; a failed original
  // (or a media with nothing behind the preview) is the end of the road.
  const settled = phase === 'retrying' || phase === 'failed'
  // Images can paint the preview itself; for video the preview is only a poster.
  const mediaSrc = isVideo || settled ? src : (preview ?? src)
  const markReady = () => setState({ identity, phase: 'ready' })
  const markFailed = () => {
    // The updater has to stay pure (StrictMode may run it twice), so the "this really
    // is over" notification is decided from what the current render already knows and
    // fired outside of it.
    const willRetry = phase === 'loading' && Boolean(preview)
    setState((current) => {
      const canRetry = current.identity === identity && current.phase === 'loading' && Boolean(preview)
      return { identity, phase: canRetry ? 'retrying' : 'failed' }
    })
    if (!willRetry) onMediaError?.()
  }

  if (!decorated) {
    if (!isVideo) {
      // `thumb` takes the preview too; `stage` can never have one, so this is the
      // original URL there and the render stays exactly as it was.
      return <img src={mediaSrc} alt={alt} className={className ?? IMAGE_CLASS[layout]} loading="lazy" />
    }
    return (
      <video
        src={videoPosterSrc(src)}
        poster={poster}
        aria-label={alt}
        className={className ?? VIDEO_CLASS[layout]}
        style={layout === 'stage' ? { aspectRatio: stageAspectRatio(aspectRatio, width, height) } : undefined}
        preload="metadata"
        muted
        playsInline
        controls={showControls === true}
      />
    )
  }

  const mediaClass = `${className ?? (isVideo ? VIDEO_CLASS.tile : IMAGE_CLASS.tile)} ${
    phase === 'ready' ? 'motion-fade-in' : ''
  }`
  // A painted poster already fills the box, so the skeleton would only hide it.
  const showSkeleton = (phase === 'loading' || phase === 'retrying') && !poster

  // Layout-shift reservation: the box the skeleton covers and the box the media
  // finally paints must be the same. `tile` stays on the forced `aspect-square`
  // crop (the grid's existing rhythm), and `width`/`height` on the img below
  // declare the true intrinsic ratio so a future uncropped tile cannot jump.
  const media = isVideo ? (
    <video
      src={videoPosterSrc(mediaSrc)}
      poster={phase === 'failed' ? undefined : poster}
      aria-label={alt}
      className={mediaClass}
      preload="metadata"
      muted
      playsInline
      controls={showControls === true}
      onLoadedMetadata={markReady}
      onLoadedData={markReady}
      onError={markFailed}
    />
  ) : (
    <img
      src={mediaSrc}
      alt={alt}
      className={mediaClass}
      width={width}
      height={height}
      loading="lazy"
      onLoad={markReady}
      onError={markFailed}
    />
  )

  return (
    <div className={WRAPPER_CLASS.tile}>
      {media}
      {showSkeleton ? <span aria-hidden="true" className="motion-shimmer absolute inset-0" /> : null}
      {phase === 'failed' ? (
        // Static, no animation: reduced motion must stay legible.
        <span className="absolute inset-0 flex items-center justify-center bg-surface-subtle">
          <ImageOff aria-hidden="true" className="h-4 w-4 text-muted-foreground/50" />
          <span className="sr-only">预览加载失败</span>
        </span>
      ) : null}
      {/* Bottom-left duration / mute chip over the functional scrim. */}
      {isVideo ? (
        <span
          className={`media-scrim bg-overlay/70 absolute flex items-center justify-start text-foreground-inverse font-mono text-xs tabular-nums ${CHIP_CLASS.tile}`}
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
      ) : null}
    </div>
  )
}
