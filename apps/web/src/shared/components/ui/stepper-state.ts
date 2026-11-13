/**
 * Pure stepper state rules, split out for `node --test`.
 *
 * A step is complete when the caller says so (`completed`), or — for the legacy
 * sequential setup wizard that only passes `current` — when it sits before the
 * current one. A visit alone never implies completion.
 */

export interface StepperStepLike {
  id?: string
  label?: unknown
  completed?: boolean
  visited?: boolean
}

export interface StepperState {
  completed: boolean
  current: boolean
  /** Only a completed/visited step may be navigated back to. */
  navigable: boolean
}

export function stepperState(step: StepperStepLike, index: number, current: number): StepperState {
  const completed = step.completed ?? index < current
  const isCurrent = index === current
  return {
    completed,
    current: isCurrent,
    navigable: completed || Boolean(step.visited),
  }
}
