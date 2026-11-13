'use client'

import type { ReactNode } from 'react'
import { CheckIcon as Check } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { controlSquare, iconSize } from './size'
import { stepperState } from './stepper-state'

export interface StepperStep {
  id: string
  label: ReactNode
  description?: ReactNode
  /** Explicit business completion. Omit for sequential-form behaviour. */
  completed?: boolean
  /** Explicit visit history; a visit never implies completion. */
  visited?: boolean
}

export interface StepperProps {
  steps: StepperStep[]
  /** 0-based index of the current step. */
  current: number
  /** Makes completed/visited steps clickable for back-navigation. */
  onStepSelect?: (index: number, step: StepperStep) => void
  /** Circle diameter: 24px (`sm`) or 32px (`md`). */
  size?: 'sm' | 'md'
  /** `auto` (default): horizontal from 640px up, vertical below it. */
  orientation?: 'auto' | 'horizontal' | 'vertical'
  className?: string
  'aria-label'?: string
}

/**
 * 安装向导 / 表单步骤条：编号圆点、圆点之间的连接线、每步标题与可选说明。已完成
 * 步骤显示对勾，传了 `onStepSelect` 时变成可点的返回按钮；未到达步骤是纯文本而
 * 不是假禁用控件。步骤顺序同时写进 `sr-only` 前缀，连接线丢失也不会丢顺序。
 */
export function Stepper({
  steps,
  current,
  onStepSelect,
  size = 'md',
  orientation = 'auto',
  className,
  'aria-label': ariaLabel = '步骤',
}: StepperProps) {
  const circle = size === 'sm' ? controlSquare.xs : controlSquare.sm
  const circleText = size === 'sm' ? 'text-xs' : 'text-sm'
  const lineTop = size === 'sm' ? 'top-3' : 'top-4'
  const horizontal = orientation !== 'vertical'
  const vertical = orientation !== 'horizontal'

  return (
    <ol
      aria-label={ariaLabel}
      className={cn(
        'flex w-full',
        orientation === 'vertical'
          ? 'flex-col'
          : orientation === 'horizontal'
            ? 'flex-row items-start'
            : 'flex-col sm:flex-row sm:items-start',
        className,
      )}
    >
      {steps.map((step, index) => {
        const state = stepperState(step, index, current)
        const last = index === steps.length - 1
        const clickable = Boolean(onStepSelect) && state.navigable && !state.current
        const labelClass = state.current || state.completed ? 'text-foreground' : 'text-muted-foreground'

        return (
          <li
            key={step.id}
            aria-current={state.current ? 'step' : undefined}
            className={cn(
              'relative flex min-w-0 gap-3',
              orientation === 'vertical'
                ? 'pb-6 last:pb-0'
                : orientation === 'horizontal'
                  ? 'flex-1 flex-col items-center gap-2 pb-0 sm:items-center'
                  : 'flex-col items-center gap-2 pb-6 last:pb-0 sm:flex-1 sm:pb-0',
            )}
          >
            {/* 连接线只出现在圆点之间的空隙里，不横穿文案。 */}
            {!last && horizontal ? (
              <span
                aria-hidden="true"
                className={cn('absolute left-1/2 h-px w-full bg-border', lineTop, orientation === 'auto' && 'max-sm:hidden')}
              />
            ) : null}
            {!last && vertical ? (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute bottom-0 top-8 w-px bg-border',
                  size === 'sm' ? 'left-3' : 'left-4',
                  orientation === 'auto' && 'sm:hidden',
                )}
              />
            ) : null}

            <span
              className={cn(
                'relative flex shrink-0 items-center justify-center rounded-pill font-medium',
                circle,
                circleText,
                state.completed && 'bg-primary text-on-primary',
                !state.completed && state.current && 'bg-surface text-primary ring-2 ring-primary',
                !state.completed && !state.current && 'border border-border-control bg-tonal text-muted-foreground',
              )}
            >
              {state.completed ? (
                <Check weight="fill" aria-hidden="true" className={iconSize.sm} />
              ) : (
                <span aria-hidden="true" className="font-mono tabular-nums">
                  {index + 1}
                </span>
              )}
            </span>

            <span className={cn('flex min-w-0 flex-col gap-0.5', horizontal && 'items-center text-center sm:items-center')}>
              <span className="sr-only">{`第 ${index + 1} 步${state.completed ? '，已完成' : ''}：`}</span>
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onStepSelect?.(index, step)}
                  className={cn('rounded-control text-sm font-medium underline-offset-4 not-disabled:hover:underline', labelClass)}
                >
                  {step.label}
                </button>
              ) : (
                <span className={cn('text-sm font-medium', labelClass)}>{step.label}</span>
              )}
              {step.description ? <span className="text-xs text-muted-foreground">{step.description}</span> : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
