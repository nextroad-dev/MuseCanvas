/** Completion is a business fact; visiting a step is only navigation. */
export function stepperState(step: { completed?: boolean; visited?: boolean }, index: number, current: number) {
  const completed = step.completed ?? index < current
  const visited = step.visited ?? index < current
  return { completed, current: index === current, navigable: completed || visited }
}
