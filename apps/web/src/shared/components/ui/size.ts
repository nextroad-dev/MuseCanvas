/**
 * Token → utility maps for the two sizes a screen sets over and over: icon boxes
 * and square controls.
 *
 * Why a map and not a raw arbitrary value: `h-[var(--icon-sm)] w-[var(--icon-sm)]`
 * was written 65 times across the app, and each copy is an independent chance to
 * typo a token name or drift back to a hardcoded pixel size. The token link is the
 * whole point of the scale, so the reference should exist once.
 *
 * Why `size-*` and not `h-* w-*`: `size-[var(--icon-sm)]` emits `width` and
 * `height` from one class, so an icon box is one literal instead of two that can
 * disagree. tailwind-merge already treats `size-*` (arbitrary values included) as
 * its own group, so `cn()` resolves a caller override the same way for both forms.
 *
 * A component that needs the height only (a row that may grow with its content)
 * uses `controlMinHeight`; a fixed square hit area uses `controlSquare`.
 */

/** Icon box, matched to the `--icon-*` scale (12 / 16 / 20 / 24 / 32 / 48). */
export const iconSize = {
  xs: 'size-[var(--icon-xs)]',
  sm: 'size-[var(--icon-sm)]',
  md: 'size-[var(--icon-md)]',
  lg: 'size-[var(--icon-lg)]',
  xl: 'size-[var(--icon-xl)]',
  '2xl': 'size-[var(--icon-2xl)]',
} as const

/** Descendant icons: size every `<svg>` a slot renders. */
export const iconSlot = {
  xs: '[&>svg]:size-[var(--icon-xs)]',
  sm: '[&>svg]:size-[var(--icon-sm)]',
  md: '[&>svg]:size-[var(--icon-md)]',
  lg: '[&>svg]:size-[var(--icon-lg)]',
  xl: '[&>svg]:size-[var(--icon-xl)]',
  '2xl': '[&>svg]:size-[var(--icon-2xl)]',
} as const

/**
 * Square control (checkbox, radio, icon-only button, avatar slot): one side equals
 * the control height, so the box and the row it sits in share a rhythm. `xs` is the
 * 24px dense toolbar size, which is square more often than it is a standalone field.
 */
export const controlSquare: Record<ControlSquareSize, string> = {
  xs: 'size-[var(--control-xs)]',
  sm: 'size-[var(--control-sm)]',
  md: 'size-[var(--control-md)]',
  lg: 'size-[var(--control-lg)]',
}

/**
 * Minimum height of a control row (button, tab, segment, checkbox label). `min-h`
 * and not `h`: wrapping text or browser zoom may grow a control, never clip it.
 */
export const controlMinHeight: Record<ControlSquareSize, string> = {
  xs: 'min-h-[var(--control-xs)]',
  sm: 'min-h-[var(--control-sm)]',
  md: 'min-h-[var(--control-md)]',
  lg: 'min-h-[var(--control-lg)]',
}

export type IconSize = keyof typeof iconSize
export type ControlSquareSize = 'xs' | 'sm' | 'md' | 'lg'
