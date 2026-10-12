import { cn } from '@/shared/lib/cn'

export interface ProgressProps {
  /**
   * Current value on the `min`…`max` scale. Pass `null` (or omit) for work whose
   * length is unknown: the bar animates and *no* percentage is claimed —
   * components.md: 未知进度不伪造百分比.
   */
  value?: number | null
  min?: number
  max?: number
  /** Label above the track, left side. */
  label?: string
  /** Right side of the label row. Defaults to the rounded percentage. */
  valueLabel?: string
  /** Set `false` when the label row above is rendered by the parent. */
  showLabelRow?: boolean
  /** 4px is the spec track; 8px is for a page-level "generating" bar. */
  size?: 'sm' | 'md'
  /**
   * `overlay` inverts the pair for a bar that sits on a media scrim (an upload
   * progress over a thumbnail): the track becomes a translucent light band and the
   * fill the inverse foreground, because `bg-tonal` on `bg-overlay` reads as a
   * printed stripe and `bg-primary` ink disappears into the scrim.
   */
  variant?: 'default' | 'overlay'
  className?: string
}

const TRACK_CLASS = {
  default: 'bg-tonal',
  overlay: 'bg-media-track',
} as const

const FILL_CLASS = {
  default: 'bg-primary',
  overlay: 'bg-on-media',
} as const

/**
 * Progress bar (components.md → Progress Bar): tonal track, `bg-primary` fill,
 * radius = half the track height, label + percentage in a space-between row above
 * the track, and a `success` fill once the work is done.
 */
export function Progress({
  value,
  min = 0,
  max = 100,
  label,
  valueLabel,
  showLabelRow = true,
  size = 'sm',
  variant = 'default',
  className,
}: ProgressProps) {
  const known = typeof value === 'number'
  const ratio = known ? Math.min(1, Math.max(0, ((value as number) - min) / (max - min || 1))) : 0
  const percent = Math.round(ratio * 100)
  const done = known && percent >= 100
  const onScrim = variant === 'overlay'
  const labelClass = onScrim ? 'text-on-media' : 'text-muted-foreground'

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {showLabelRow ? (
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className={cn('min-w-0 truncate', labelClass)}>{label}</span>
          {known ? (
            <span className={cn('shrink-0 font-mono text-xs tabular-nums', labelClass)}>
              {valueLabel ?? `${percent}%`}
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        role="progressbar"
        aria-valuemin={known ? min : undefined}
        aria-valuemax={known ? max : undefined}
        aria-valuenow={known ? (value as number) : undefined}
        aria-valuetext={known ? (valueLabel ?? `${percent}%`) : undefined}
        aria-label={label}
        className={cn('w-full overflow-hidden rounded-pill', TRACK_CLASS[variant], size === 'sm' ? 'h-1' : 'h-2')}
      >
        {known ? (
          <div
            className={cn(
              // `.motion-position` is the width glide at --motion-base / --ease-standard.
              'motion-position h-full rounded-pill',
              FILL_CLASS[variant],
              done && 'bg-success',
            )}
            style={{ width: `${percent}%` }}
          />
        ) : (
          // Indeterminate: a travelling segment, never a fake value.
          <div
            className={cn('motion-progress-indeterminate h-full w-1/3 rounded-pill', FILL_CLASS[variant])}
          />
        )}
      </div>
    </div>
  )
}
