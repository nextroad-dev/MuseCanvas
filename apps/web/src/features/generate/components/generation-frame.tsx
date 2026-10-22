'use client'

import { parseImageSize } from '@musecanvas/contracts'
import { MediaFrame } from '@/shared/components/media-frame'
import { Progress } from '@/shared/components/ui'
import { cn } from '@/shared/lib/cn'
import type { GenerationJob, JobStatus } from '@/shared/types'

export type GenerationFramePhase = 'generating' | 'done' | 'failed'

export interface GenerationFrameProps {
  /** CSS `aspect-ratio` value, e.g. `"3 / 4"`. Constant across the job's life. */
  aspect: string
  phase: GenerationFramePhase
  /** Truthful stage copy, e.g. `phaseLabel(job.phase)` + `…`. Never a percentage. */
  phaseText: string
  /** Mono geometry line, e.g. `"3:4 · 1024 × 1365"`. */
  sizeLabel?: string
  src?: string
  video?: boolean
  alt?: string
  poster?: string
  /** Error copy when the phase is `failed` and there is no media. */
  errorText?: string
  /** Click-through to the result dialog. Rendered only once media exists. */
  onOpen?: () => void
  openLabel?: string
}

/**
 * The core moment of a generation result: one box, reserved at the target
 * aspect from the first frame, shimmering with stage copy while the job runs,
 * then fading the real media in inside the *same* box. The container's aspect
 * never changes, so `running → succeeded` cannot shift layout.
 *
 * Reduced motion needs nothing here: the global rule zeroes the shimmer and
 * the indeterminate travel, leaving a static placeholder and static copy.
 */
export function GenerationFrame({
  aspect,
  phase,
  phaseText,
  sizeLabel,
  src,
  video = false,
  alt = '',
  poster,
  errorText,
  onOpen,
  openLabel = '查看原图与元信息',
}: GenerationFrameProps) {
  const settled = phase === 'done' && src
  return (
    <div
      style={{ aspectRatio: aspect }}
      className="relative w-full max-w-[300px] overflow-hidden rounded-card bg-tonal"
    >
      {settled ? (
        <div key={src} className="motion-fade-in-slow absolute inset-0 [&>div]:h-full">
          <MediaFrame
            src={src}
            kind={video ? 'video' : 'image'}
            alt={alt}
            layout="tile"
            showControls={false}
            className="h-full w-full object-cover"
            {...(poster ? { previewSrc: poster } : {})}
          />
        </div>
      ) : phase === 'failed' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-sm text-muted-foreground">{errorText ?? '生成失败'}</p>
        </div>
      ) : (
        <>
          <span aria-hidden="true" className="motion-shimmer absolute inset-0" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
            {sizeLabel ? (
              <span className="font-mono text-caption tabular-nums text-muted-foreground">{sizeLabel}</span>
            ) : null}
            <span className="text-sm text-foreground">{phaseText}</span>
          </div>
          <div className="absolute inset-x-0 bottom-0">
            <Progress value={null} label={phaseText} showLabelRow={false} />
          </div>
        </>
      )}
      {settled && onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel}
          className={cn(
            'group absolute inset-0 block w-full cursor-zoom-in',
            'focus-visible:outline-2 focus-visible:-outline-offset-2',
          )}
        />
      ) : null}
    </div>
  )
}

/** `running → succeeded` maps onto the frame's three phases. */
export function framePhaseForStatus(status: JobStatus): GenerationFramePhase {
  if (status === 'succeeded') return 'done'
  if (status === 'failed' || status === 'canceled') return 'failed'
  return 'generating'
}

function normalizeRatioToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parts = value.split(/[:/]/).map((part) => part.trim()).filter(Boolean)
  if (parts.length !== 2) return null
  const [first, second] = parts as [string, string]
  if (!/^\d+(\.\d+)?$/.test(first) || !/^\d+(\.\d+)?$/.test(second)) return null
  if (Number(first) <= 0 || Number(second) <= 0) return null
  return `${first} / ${second}`
}

/**
 * Target aspect for the frame, from the most trustworthy signal available:
 * `outputs[0].metadata` width/height → `aspectRatio` → `parameters` aliases
 * (`aspectRatio` / `aspect_ratio` / `ratio`) → `job.size` through
 * `parseImageSize`. Anything unparseable (including `auto`) falls back to
 * `1 / 1` rather than collapsing the box.
 */
export function resolveFrameAspect(job: Pick<GenerationJob, 'outputs' | 'parameters' | 'size'>): string {
  const metadata = job.outputs?.[0]?.metadata as
    | { width?: unknown; height?: unknown; aspectRatio?: unknown }
    | undefined
  const width = metadata?.width
  const height = metadata?.height
  if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
    return `${width} / ${height}`
  }
  const parameters = (job.parameters ?? {}) as Record<string, unknown>
  for (const candidate of [metadata?.aspectRatio, parameters.aspectRatio, parameters.aspect_ratio, parameters.ratio]) {
    const normalized = normalizeRatioToken(candidate)
    if (normalized) return normalized
  }
  for (const candidate of [parameters.size, job.size]) {
    if (typeof candidate !== 'string') continue
    const parsed = parseImageSize(candidate)
    if (parsed) return `${parsed.width} / ${parsed.height}`
  }
  return '1 / 1'
}

/** Mono geometry line for the generating frame, e.g. `"3:4 · 1024 × 1365"`. */
export function frameSizeLabel(job: Pick<GenerationJob, 'outputs' | 'parameters' | 'size'>): string {
  const metadata = job.outputs?.[0]?.metadata as
    | { width?: unknown; height?: unknown }
    | undefined
  const width = metadata?.width
  const height = metadata?.height
  const ratioPretty = resolveFrameAspect(job).replace(/\s*\/\s*/, ':')
  if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
    return `${ratioPretty} · ${width} × ${height}`
  }
  const parameters = (job.parameters ?? {}) as Record<string, unknown>
  for (const candidate of [parameters.size, job.size]) {
    if (typeof candidate !== 'string') continue
    const pretty = candidate.replace(/^(\d+)x(\d+)$/, '$1 × $2')
    return ratioPretty === '1:1' ? pretty : `${ratioPretty} · ${pretty}`
  }
  return ratioPretty === '1:1' ? '' : ratioPretty
}
