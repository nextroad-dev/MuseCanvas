/**
 * 图标尺寸与方形控件的 token → 工具类映射。
 *
 * 用 `size-[var(--icon-*)]` 而不是手写 `h-[…] w-[…]`：一个类同时输出宽高，避免两个
 * 类写歪；token 检查规则 D 也会拦下手写尺寸对。只需要高度下限的行用
 * `controlMinHeight`，固定方形热区用 `controlSquare`。
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

/** 方形控件（checkbox / radio / 图标按钮 / 头像槽）：边长等于控件高度。 */
export const controlSquare = {
  xs: 'size-[var(--control-xs)]',
  sm: 'size-[var(--control-sm)]',
  md: 'size-[var(--control-md)]',
  lg: 'size-[var(--control-lg)]',
} as const

/** 控件行最小高度（按钮、标签页、分段项、复选框标签）。用 min-h 而非 h，避免裁切。 */
export const controlMinHeight = {
  xs: 'min-h-[var(--control-xs)]',
  sm: 'min-h-[var(--control-sm)]',
  md: 'min-h-[var(--control-md)]',
  lg: 'min-h-[var(--control-lg)]',
} as const

export type IconSize = keyof typeof iconSize
export type ControlSquareSize = keyof typeof controlSquare
export type ControlMinHeightSize = keyof typeof controlMinHeight

/** 移动端触控目标下限（44px）：桌面尺寸偏小的控件在 <640px 时补足。 */
export const touchTarget = 'max-sm:min-h-11'

/** 图标按钮的移动端方形触控下限（44×44px）。 */
export const touchTargetSquare = 'max-sm:size-11'
