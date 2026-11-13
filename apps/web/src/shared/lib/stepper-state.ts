// 步骤条状态：完成是业务事实，访问过只是导航痕迹。
// 返回 `navigable` 供步骤条决定是否可点击跳回。

export interface StepperStepInput {
  completed?: boolean
  visited?: boolean
}

export interface StepperStepState {
  completed: boolean
  current: boolean
  navigable: boolean
}

export function stepperState(
  step: StepperStepInput,
  index: number,
  current: number,
): StepperStepState {
  const completed = step.completed ?? index < current
  const visited = step.visited ?? index < current
  return { completed, current: index === current, navigable: completed || visited }
}
