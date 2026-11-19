import { cn } from '@/shared/lib/cn'

export interface ProgressProps {
  /** 当前值；省略或 `null` 时切换为不定态动画，绝不伪造百分比。 */
  value?: number | null
  min?: number
  max?: number
  /** Label above the track, left side. */
  label?: string
  /** Right side of the label row. Defaults to the rounded percentage. */
  valueLabel?: string
  /** Set `false` when the label row is rendered by the parent. */
  showLabelRow?: boolean
  /** `sm` = 4px track; `md` = 8px page-level bar. */
  size?: 'sm' | 'md'
  /** `overlay` 用于深色媒体底上的进度条。 */
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
  const known = typeof value === 'number' && Number.isFinite(value)
  const ratio = known ? Math.min(1, Math.max(0, ((value as number) - min) / (max - min || 1))) : 0
  const percent = Math.round(ratio * 100)
  const done = known && percent >= 100
  const onScrim = variant === 'overlay'
  const labelClass = onScrim ? 'text-on-media' : 'text-muted-foreground'

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {showLabelRow && (label || known) ? (
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
            className={cn('motion-position h-full rounded-pill', FILL_CLASS[variant], done && 'bg-success')}
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className={cn('motion-progress-indeterminate h-full w-1/3 rounded-pill', FILL_CLASS[variant])} />
        )}
      </div>
    </div>
  )
}
