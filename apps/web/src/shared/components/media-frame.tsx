'use client'

import { useState } from 'react'
import { ImageBrokenIcon as ImageOff, PlayIcon as Play, SpeakerSlashIcon as VolumeX } from '@phosphor-icons/react'
import type { MediaKind } from '@/shared/types'
import { iconSize, Spinner } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'

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
  /** Worker-derived preview (≈512px WebP / JPEG poster) for this asset. `tile`
  *  and `thumb` use it as the first paint; `stage` also paints it first (no
  *  shimmer) and fades the full-size `src` in over it once decoded, so Slow 3G
  *  still shows the first frame immediately. `src` stays the real media either
  *  way, so retry, click-through and download never see the thumbnail. For
  *  video it becomes `poster`, for an image the first-paint `src`. */
  previewSrc?: string
  /** Full class string for the media element. Callers own their exact styling so
   *  swapping in this component never moves existing pixels; omit to use the
   *  per-layout defaults below. */
  className?: string
  /** Fired when the original `src` fails (after the internal preview→original
   *  retry is spent on `tile`). A presigned URL expiring is the case this
   *  exists for: the caller can re-sign and hand back a new `src`, and the
   *  identity change resets the load cycle. On `stage` the preview stays
   *  painted behind the failure note, so the frame never goes blank. Omit it
   *  and behaviour is unchanged. */
  onMediaError?: () => void
}

/** Media element classes for still images. `tile`/`thumb` mirror the library grid
 *  and the console history rail; `stage` mirrors the console result grid. No hover
 *  transform: a card or tile that grows under the pointer is off-spec, so the tile
 *  reports hover with the overlay below instead, and `motion-hover-fade` (120ms)
 *  is the only timing used. */
const IMAGE_CLASS: Record<MediaFrameLayout, string> = {
  tile: 'aspect-square w-full object-cover',
  stage: 'h-auto w-full object-cover',
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
  tile: 'bottom-1 left-1 gap-1 rounded-control px-1.5 py-0.5',
  thumb: 'inset-x-0 bottom-0 gap-0.5 rounded-none px-1 py-px',
}

/** Neutral hover wash for a tile: `--color-overlay` at `--opacity-ghost-hover`
 *  (6% light, 8% dark). A color-mix rather than an `opacity` utility, because the
 *  overlay element itself animates `opacity` on hover. */
const HOVER_TINT = 'color-mix(in srgb, var(--color-overlay) calc(var(--opacity-ghost-hover) * 100%), transparent)'

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
 *  loading skeleton; `thumb` keeps rendering the exact same markup it did
 *  before, and `stage` owns its progressive preview→original lifecycle below
 *  (preview first, no shimmer, original fades in on top). */
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
  if (layout === 'stage') {
    return (
      <StageMedia
        src={src}
        kind={kind}
        alt={alt}
        previewSrc={previewSrc}
        aspectRatio={aspectRatio}
        width={width}
        height={height}
        showControls={showControls}
        className={className}
        onMediaError={onMediaError}
      />
    )
  }

  const isVideo = kind === 'video'
  // A preview that *is* the original (no thumbnail derived yet) is no preview at
  // all: keeping it would burn the one retry on a request that already failed.
  const rawPreview = asPreviewUrl(previewSrc)
  // A preview that *is* the original (no thumbnail derived yet) is no preview at
  // all: keeping it would burn the one retry on a request that already failed.
  const preview = rawPreview && rawPreview !== src ? rawPreview : undefined
  const poster = isVideo ? preview : undefined

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

  if (layout === 'thumb') {
    if (!isVideo) {
      return <img src={mediaSrc} alt={alt} className={className ?? IMAGE_CLASS.thumb} loading="lazy" onError={onMediaError} />
    }
    return (
      <video
        src={videoPosterSrc(src)}
        poster={poster}
        aria-label={alt}
        className={className ?? VIDEO_CLASS.thumb}
        preload="metadata"
        muted
        playsInline
      />
    )
  }

  const mediaClass = `${className ?? (isVideo ? VIDEO_CLASS.tile : IMAGE_CLASS.tile)} ${
    phase === 'ready' ? 'motion-fade-in' : ''
  }`
  const busy = phase === 'loading' || phase === 'retrying'
  // A painted poster already fills the box, so the skeleton would only hide it.
  const showSkeleton = busy && !poster

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
    <div className={WRAPPER_CLASS.tile} aria-busy={busy}>
      {media}
      {/* Hover feedback without motion: the tile darkens by the neutral hover
          opacity instead of lifting or scaling, on `motion-hover-fade` (120ms). */}
      <span
        aria-hidden="true"
        style={{ backgroundColor: HOVER_TINT }}
        className="motion-hover-fade pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      />
      {showSkeleton ? <span aria-hidden="true" className="motion-shimmer absolute inset-0" /> : null}
      {phase === 'failed' ? (
        // Static, no animation: reduced motion must stay legible. The glyph sits on
        // the full muted foreground (5.8:1 on white), not a 50% wash — a 3:1 graphic
        // has to survive as the only clue that this cell is broken.
        <span className="absolute inset-0 flex items-center justify-center bg-tonal">
          <ImageOff weight="duotone" aria-hidden="true" className={`${iconSize.lg} text-muted-foreground`} />
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
              <VolumeX weight="bold" className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">无声</span>
            </>
          ) : (
            <>
              <Play weight="fill" className="h-3 w-3" aria-hidden="true" />
              <span>{formatDuration(durationSeconds)}</span>
            </>
          )}
        </span>
      ) : null}
    </div>
  )
}

/** `stage` without a usable preview: the existing failure card, unchanged. */
function StageFailure({
  aspectRatio,
  width,
  height,
  className,
  onRetry,
}: {
  aspectRatio?: string
  width?: number
  height?: number
  className?: string
  onRetry: (() => void) | undefined
}) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center gap-2 rounded-card border border-border bg-tonal p-8 text-center', className)}
      style={{ aspectRatio: stageAspectRatio(aspectRatio, width, height) }}
    >
      <ImageOff weight="duotone" aria-hidden="true" className={`${iconSize.xl} text-muted-foreground`} />
      <p className="text-sm text-muted-foreground">媒体资源加载失败或链接已失效</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="text-xs font-medium text-primary underline underline-offset-4 hover:text-foreground"
        >
          重新加载 / 重新签名
        </button>
      ) : null}
    </div>
  )
}

/**
 * The large preview surface (the lightbox stage). The worker preview paints
 * first — no shimmer, so Slow 3G still shows the first frame immediately — and
 * the full-size original fades in over it (`.motion-fade-in`) once decoded,
 * at which point the preview layer is removed. An original that fails keeps
 * the preview painted and adds the failure note below; only a stage with no
 * usable preview falls back to the failure card. The capsule is the single
 * `role="status"` announcer for the original fetch.
 */
function StageMedia({
  src,
  kind,
  alt,
  previewSrc,
  aspectRatio,
  width,
  height,
  showControls,
  className,
  onMediaError,
}: {
  src: string
  kind: MediaKind
  alt: string
  previewSrc?: string
  aspectRatio?: string
  width?: number
  height?: number
  showControls?: boolean
  className?: string
  onMediaError?: () => void
}) {
  const isVideo = kind === 'video'
  const preview = asPreviewUrl(previewSrc)
  // A preview that *is* the original is no preview at all.
  const stagedPreview = preview && preview !== src ? preview : undefined

  const identity = `${kind}|${src}|${stagedPreview ?? ''}`
  const [state, setState] = useState({ identity, originalReady: false, originalFailed: false, previewGone: false })
  // Source swapped (flipped asset, URL re-signed): reset during render rather
  // than in an effect, so no frame ever shows the old element state.
  if (state.identity !== identity) {
    setState({ identity, originalReady: false, originalFailed: false, previewGone: false })
  }
  const current = state.identity === identity ? state : { identity, originalReady: false, originalFailed: false, previewGone: false }
  const { originalReady, originalFailed } = current
  // A preview that itself 404s (expired thumbnail) is dropped so the original
  // paints directly instead of leaving a broken frame behind it.
  const livePreview = current.previewGone ? undefined : stagedPreview
  const loading = !originalReady && !originalFailed

  function markOriginalReady() {
    setState({ identity, originalReady: true, originalFailed: false, previewGone: current.previewGone })
  }
  function markOriginalFailed() {
    setState({ identity, originalReady: false, originalFailed: true, previewGone: current.previewGone })
    onMediaError?.()
  }
  function markPreviewGone() {
    setState({ identity, originalReady: current.originalReady, originalFailed: current.originalFailed, previewGone: true })
  }
  function retryOriginal() {
    setState({ identity, originalReady: false, originalFailed: false, previewGone: false })
    onMediaError?.()
  }

  const capsule = loading ? (
    <p role="status" className="absolute left-4 top-4 inline-flex items-center gap-2 rounded-pill bg-overlay/70 px-3 py-1.5 text-xs text-foreground-inverse">
      <Spinner size="sm" />
      正在加载原图
    </p>
  ) : null
  const failureNote = originalFailed && livePreview ? (
    <div className="absolute inset-x-0 bottom-0 flex justify-center p-4">
      <p role="alert" className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-pill bg-overlay/70 px-3 py-1.5 text-center text-xs text-foreground-inverse">
        <span>原图加载失败，当前显示预览图。</span>
        {onMediaError ? (
          <button type="button" onClick={retryOriginal} className="font-medium underline underline-offset-4">
            重新加载
          </button>
        ) : null}
      </p>
    </div>
  ) : null

  if (isVideo) {
    if (originalFailed && !livePreview) {
      return <StageFailure aspectRatio={aspectRatio} width={width} height={height} className={className} onRetry={onMediaError ? retryOriginal : undefined} />
    }
    return (
      <div className="relative flex w-full items-center justify-center overflow-hidden" aria-busy={loading}>
        <video
          src={videoPosterSrc(src)}
          poster={livePreview}
          aria-label={alt}
          className={`${className ?? VIDEO_CLASS.stage} ${originalReady ? 'motion-fade-in' : ''}`}
          style={{ aspectRatio: stageAspectRatio(aspectRatio, width, height) }}
          preload="metadata"
          muted
          playsInline
          controls={showControls === true}
          onLoadedMetadata={markOriginalReady}
          onLoadedData={markOriginalReady}
          onError={markOriginalFailed}
        />
        {failureNote}
        {capsule}
      </div>
    )
  }

  if (originalFailed && !livePreview) {
    return <StageFailure aspectRatio={aspectRatio} width={width} height={height} className={className} onRetry={onMediaError ? retryOriginal : undefined} />
  }
  const mediaClass = className ?? IMAGE_CLASS.stage
  // The base state is always a painted frame (preview, or the original itself
  // when there is no preview), never a blank box — the fail-visible rule.
  const behindPreview = Boolean(livePreview) && !originalReady
  return (
    <div className="relative flex w-full items-center justify-center overflow-hidden" aria-busy={loading}>
      {livePreview && !originalReady ? (
        <img src={livePreview} alt="" aria-hidden="true" className={mediaClass} loading="eager" onError={markPreviewGone} />
      ) : null}
      {!originalFailed ? (
        <img
          src={src}
          alt={alt}
          aria-hidden={behindPreview || undefined}
          className={behindPreview ? 'pointer-events-none absolute h-px w-px opacity-0' : `${mediaClass} ${originalReady ? 'motion-fade-in' : ''}`}
          width={width}
          height={height}
          loading="eager"
          onLoad={markOriginalReady}
          onError={markOriginalFailed}
        />
      ) : null}
      {failureNote}
      {capsule}
    </div>
  )
}
