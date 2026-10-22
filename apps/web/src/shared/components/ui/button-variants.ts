import { cva, type VariantProps } from 'class-variance-authority'
import { controlMinHeight, controlSquare, iconSlot } from './size'

export type ButtonVariant = NonNullable<VariantProps<typeof buttonCva>['variant']>
export type ButtonSize = NonNullable<VariantProps<typeof buttonCva>['size']>

/**
 * The one button recipe. Two rules shape it:
 *  · states.md §2 — primary is dark ink (never the brand green), secondary is
 *    tonal, ghost is a 6%/10% scrim, danger solid is reserved for destructive
 *    confirms, `danger-ghost` is for aborts.
 *  · states.md §9 — Loading outranks Hover, so hover/active paint is compiled
 *    out (`state: 'busy'`) instead of being "overridden".
 * Focus is deliberately absent here: globals.css owns the single ring.
 * Press and colour motion come from `.motion-press`, the same class every other
 * pressable control uses (see `interaction.ts`).
 *
 * ## Why the guard is `:not(:disabled)` and not `enabled:`
 * Navigation wears this recipe too (components.md 通用 — 导航用链接、动作用 button),
 * and `:enabled` matches *form controls only*: on an `<a>` every
 * `enabled:hover:…` variant is dead, so a link built from this recipe looked
 * hoverable but never responded. `:not(:disabled)` matches an `<a href>` (it is
 * never in the disabled state) and still excludes a real `disabled` button, so
 * one set of classes covers both. `Button` adds `.is-disabled` for the cursor /
 * opacity treatment, and `aria-disabled` blocking lives in `Button` itself.
 */
const buttonCva = cva(
  [
    'relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap',
    'rounded-control text-sm font-medium',
    `${iconSlot.sm} [&>svg]:shrink-0`,
    'motion-press',
  ].join(' '),
  {
    variants: {
      variant: {
        primary: 'bg-primary text-on-primary',
        secondary: 'bg-tonal text-foreground',
        ghost: 'bg-transparent text-foreground',
        'danger-ghost': 'bg-transparent text-danger',
        danger: 'bg-danger text-on-danger',
      },
      // 40px default, 32px dense toolbars, 48px touch (components.md 通用).
      size: {
        sm: `${controlMinHeight.sm} gap-2 px-3`,
        md: `${controlMinHeight.md} gap-2 px-4`,
        lg: `${controlMinHeight.lg} gap-2 px-5 ${iconSlot.md}`,
      },
      state: {
        idle: '',
        busy: '',
      },
      iconOnly: {
        true: '',
        false: '',
      },
      fullWidth: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md', state: 'idle' },
    compoundVariants: [
      { variant: 'primary', state: 'idle', className: 'not-disabled:hover:bg-primary-hover not-disabled:active:bg-primary-active' },
      { variant: 'secondary', state: 'idle', className: 'not-disabled:hover:bg-tonal-hover not-disabled:active:bg-tonal-active' },
      // Ghost scrim = `--opacity-ghost-hover` / `--opacity-ghost-active`, which
      // already flip per theme (light .06/.10, dark .08/.14), so one pair of
      // classes covers both themes — no `dark:` duplicates.
      {
        variant: 'ghost',
        state: 'idle',
        className:
          'not-disabled:hover:bg-foreground/(--opacity-ghost-hover) not-disabled:active:bg-foreground/(--opacity-ghost-active)',
      },
      {
        variant: 'danger-ghost',
        state: 'idle',
        className:
          'not-disabled:hover:bg-danger/(--opacity-ghost-hover) not-disabled:active:bg-danger/(--opacity-ghost-active)',
      },
      { variant: 'danger', state: 'idle', className: 'not-disabled:hover:bg-danger-hover not-disabled:active:bg-danger-active' },
      // Square hit area, equal to the control height of the matching size.
      { iconOnly: true, size: 'sm', className: `${controlSquare.sm} px-0` },
      { iconOnly: true, size: 'md', className: `${controlSquare.md} px-0` },
      { iconOnly: true, size: 'lg', className: `${controlSquare.lg} px-0` },
    ],
  },
)

export interface ButtonVariantProps {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  /** Icon-only control: becomes square. Supply an accessible name. */
  iconOnly?: boolean
  /** Drop hover/active paint the way a busy button really behaves. */
  loading?: boolean
  className?: string
}

/**
 * Class-only escape hatch so a real `<Link>` (navigation) can wear the button
 * styling without the button role. Lives in its own directive-free module:
 * `button.tsx` needs `'use client'` for its refs and width lock, and a server
 * component may render a client module but never *call* its exports — this file
 * can be imported from either side.
 */
export function buttonVariants({
  variant = 'primary',
  size = 'md',
  fullWidth,
  iconOnly,
  loading,
  className,
}: ButtonVariantProps = {}): string {
  return buttonCva({ variant, size, fullWidth, iconOnly, state: loading ? 'busy' : 'idle', className })
}

/**
 * Quiet square icon button: a muted glyph that wears a tonal wash on hover and
 * press. The chrome of the dialog close, toast dismiss and theme toggle. It is a
 * different recipe from the `ghost` Button variant (a text-tone scrim), on purpose:
 * these sit on top of content and must read as chrome, not as an action.
 */
export const ghostIconButtonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center rounded-control text-muted-foreground',
    'not-disabled:hover:bg-tonal-hover not-disabled:hover:text-foreground not-disabled:active:bg-tonal-active',
    'motion-press',
  ].join(' '),
  {
    variants: {
      size: {
        sm: controlSquare.sm,
        md: controlSquare.md,
      },
    },
    defaultVariants: { size: 'sm' },
  },
)
