'use client'

import type { CSSProperties, ReactNode } from 'react'
import { CheckIcon as Check } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { controlSquare, iconSize } from './size'
import { stepperState } from '@/shared/lib/stepper-state'

export interface StepperStep {
  id: string
  label: ReactNode
  description?: ReactNode
  /** Explicit business completion. Omit for legacy sequential-form behavior. */
  completed?: boolean
  /** Explicit visit history; a visit never implies completion. */
  visited?: boolean
}

export interface StepperProps {
  steps: StepperStep[]
  /** 0-based index of the current step. */
  current: number
  /**
   * Makes *completed* steps clickable for back-navigation (components.md →
   * Stepper: 已完成的步骤可点击进行导航跳转). Unreached steps render as plain
   * text instead of a fake-disabled control.
   */
  onStepSelect?: (index: number, step: StepperStep) => void
  /** Circle diameter: 24px for dense flows, 32px default. */
  size?: 'sm' | 'md'
  /** `auto` (default): horizontal from 640px up, vertical below it. */
  orientation?: 'auto' | 'horizontal' | 'vertical'
  className?: string
  'aria-label'?: string
}

export function Stepper({
  steps,
  current,
  onStepSelect,
  size = 'md',
  orientation = 'auto',
  className,
  'aria-label': ariaLabel = '步骤',
}: StepperProps) {
  const radius = size === 'sm' ? 12 : 16
  const showVerticalTrack = orientation !== 'horizontal'
  const showHorizontalTrack = orientation !== 'vertical'
  const verticalTrackStyle: CSSProperties = { left: radius - 0.5, top: radius * 2 + 8, bottom: 0 }
  const horizontalTrackStyle: CSSProperties = { top: radius - 0.5 }

  return (
    <ol
      aria-label={ariaLabel}
      className={cn(
        'flex w-full',
        orientation === 'vertical' ? 'flex-col' : orientation === 'horizontal' ? 'flex-row items-start' : 'flex-col sm:flex-row sm:items-start',
        className,
      )}
    >
      {steps.map((step, index) => {
        const state = stepperState(step, index, current)
        const done = state.completed
        const isCurrent = state.current
        const last = index === steps.length - 1
        const clickable = state.navigable && !isCurrent && Boolean(onStepSelect)

        return (
          <li
            key={step.id}
            aria-current={isCurrent ? 'step' : undefined}
            className={cn(
              'relative flex min-w-0 flex-col gap-2',
              orientation === 'vertical' ? 'pb-6 last:pb-0' : 'pb-6 last:pb-0 sm:flex-1 sm:items-center sm:pb-0',
              orientation === 'horizontal' && 'flex-1 items-center pb-0',
            )}
          >
            {/* Connectors live in the gap between circles, never across a label. */}
            {!last && showVerticalTrack ? (
              <span
                aria-hidden="true"
                style={verticalTrackStyle}
                className={cn('absolute w-px bg-border', orientation === 'auto' && 'sm:hidden')}
              />
            ) : null}
            {index > 0 && showHorizontalTrack ? (
              <span
                aria-hidden="true"
                style={horizontalTrackStyle}
                className={cn(
                  'absolute right-1/2 left-[-50%] h-px bg-border',
                  orientation === 'auto' ? 'max-sm:hidden' : 'block',
                )}
              />
            ) : null}

            <span
              className={cn(
                'relative z-sticky flex shrink-0 items-center justify-center self-start rounded-pill font-medium',
                size === 'sm' ? `${controlSquare.xs} text-xs` : `${controlSquare.sm} text-sm`,
                orientation !== 'vertical' && 'sm:self-center',
                orientation === 'horizontal' && 'self-center',
                done && 'bg-primary text-on-primary',
                isCurrent && 'bg-surface text-primary ring-2 ring-primary',
                !done && !isCurrent && 'border border-border-control bg-tonal text-muted-foreground',
              )}
            >
              {done ? (
                <Check weight="fill" aria-hidden="true" className={iconSize.sm} />
              ) : (
                <span aria-hidden="true" className="font-mono tabular-nums">
                  {index + 1}
                </span>
              )}
            </span>

            <span className={cn('flex min-w-0 flex-col gap-0.5 text-left', orientation !== 'vertical' && 'sm:items-center sm:text-center')}>
              {/* The order is stated in words too, so it survives a lost connector line. */}
              <span className="sr-only">{`第 ${index + 1} 步${done ? '，已完成' : ''}：`}</span>
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onStepSelect?.(index, step)}
                  className="rounded-control text-sm font-medium text-foreground underline-offset-4 not-disabled:hover:underline"
                >
                  {step.label}
                </button>
              ) : (
                <span className={cn('text-sm font-medium', isCurrent ? 'text-foreground' : 'text-muted-foreground')}>
                  {step.label}
                </span>
              )}
              {step.description ? <span className="text-xs text-muted-foreground">{step.description}</span> : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
