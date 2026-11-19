/**
 * 图标尺寸与控件尺寸的 token → 工具类映射。
 *
 * 统一使用 `iconSize` / `controlSquare` 单类映射输出宽高，
 * 避免手写宽高对。控件高度统一收敛为 4 档：xs(28) / sm(32) / md(36) / lg(44)。
 */

/** 图标容器，对应 `--icon-*`（12 / 16 / 20 / 24 / 32 / 48）。 */
export const iconSize = {
  xs: 'size-[var(--icon-xs)]',
  sm: 'size-[var(--icon-sm)]',
  md: 'size-[var(--icon-md)]',
  lg: 'size-[var(--icon-lg)]',
  xl: 'size-[var(--icon-xl)]',
  '2xl': 'size-[var(--icon-2xl)]',
} as const

/** 作用于插槽内所有 `<svg>` 的图标尺寸。 */
export const iconSlot = {
  xs: '[&>svg]:size-[var(--icon-xs)]',
  sm: '[&>svg]:size-[var(--icon-sm)]',
  md: '[&>svg]:size-[var(--icon-md)]',
  lg: '[&>svg]:size-[var(--icon-lg)]',
  xl: '[&>svg]:size-[var(--icon-xl)]',
  '2xl': '[&>svg]:size-[var(--icon-2xl)]',
} as const

/** 方形控件（图标按钮 / 头像槽 / 复选框热区）：边长等于控件高度（28 / 32 / 36 / 44）。 */
export const controlSquare = {
  xs: 'size-[var(--control-xs)]',
  sm: 'size-[var(--control-sm)]',
  md: 'size-[var(--control-md)]',
  lg: 'size-[var(--control-lg)]',
} as const

/** 控件行最小高度（按钮 / 输入框 / 标签页 / 分段项）：用 min-h 避免裁切。 */
export const controlMinHeight = {
  xs: 'min-h-[var(--control-xs)]',
  sm: 'min-h-[var(--control-sm)]',
  md: 'min-h-[var(--control-md)]',
  lg: 'min-h-[var(--control-lg)]',
} as const

export type IconSize = keyof typeof iconSize
export type ControlSquareSize = keyof typeof controlSquare
export type ControlMinHeightSize = keyof typeof controlMinHeight

/** 移动端触控目标下限（44px = `--control-lg`）：桌面紧凑控件在 <640px 自动补足。 */
export const touchTarget = 'max-sm:min-h-[var(--control-lg)]'

/** 图标按钮的移动端方形触控下限（44×44px = `--control-lg`）。 */
export const touchTargetSquare = 'max-sm:size-[var(--control-lg)]'
