'use client'

import { useEffect, useRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/shared/lib/cn'
import { buttonVariants } from './button-variants'
import type { ButtonSize, ButtonVariant } from './button-variants'
import { Spinner } from './spinner'

// The recipe itself lives in `button-variants.ts`, a directive-free module: this
// file needs `'use client'` for the width lock below, and a server component may
// render a client module but never call its exports. Re-exported here so every
// existing `from './button'` / `from '@/shared/components/ui'` import keeps
// working while `buttonVariants` stays callable from RSC (marketing pages).
export { buttonVariants, ghostIconButtonVariants } from './button-variants'
export type { ButtonSize, ButtonVariant, ButtonVariantProps } from './button-variants'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Leading icon. Swapped for the spinner while `loading`, so the slot never moves. */
  icon?: ReactNode
  /**
   * Async in flight: the label stays visible and the button keeps its width,
   * `aria-busy` is set, repeat activation is blocked (mouse *and* keyboard) and
   * the cursor becomes `wait` — states.md §4 / components.md Button row.
   */
  loading?: boolean
  fullWidth?: boolean
  /** Internal: `IconButton` reuses `Button` and only adds the square geometry. */
  iconOnly?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  fullWidth,
  iconOnly,
  className,
  style,
  disabled,
  onClick,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const nodeRef = useRef<HTMLButtonElement | null>(null)
  const idleWidthRef = useRef<number | null>(null)
  // Only primitive labels are tracked: measuring on every render would force a
  // reflow per button, and a busy label is stable by definition.
  const label = typeof children === 'string' || typeof children === 'number' ? String(children) : null
  // Measured on the last idle commit, so the render that turns busy already has it.
  useEffect(() => {
    if (loading) return
    const el = nodeRef.current
    if (el) idleWidthRef.current = el.offsetWidth
  }, [loading, label])

  const setRef = (node: HTMLButtonElement | null) => {
    nodeRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) (ref as { current: HTMLButtonElement | null }).current = node
  }

  const ariaDisabled = rest['aria-disabled'] === true || rest['aria-disabled'] === 'true'
  const blocked = loading || ariaDisabled
  const lockedWidth = loading ? idleWidthRef.current : null

  return (
    <button
      type="button"
      {...rest}
      ref={setRef}
      disabled={disabled}
      aria-busy={loading || undefined}
      onClick={(event) => {
        // aria-disabled does not stop activation by itself: block it here so
        // Enter/Space (which fire click) obey it too.
        if (blocked) {
          event.preventDefault()
          return
        }
        onClick?.(event)
      }}
      style={lockedWidth ? { ...style, minWidth: `${lockedWidth}px` } : style}
      className={cn(
        buttonVariants({ variant, size, fullWidth, iconOnly, loading }),
        (disabled || ariaDisabled) && 'is-disabled',
        loading && 'cursor-wait',
        className,
      )}
    >
      {loading ? <Spinner size={size === 'lg' ? 'md' : 'sm'} /> : icon}
      {children}
    </button>
  )
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'aria-label'> {
  icon: ReactNode
  /** Required: an icon-only control has no text to derive a name from (icons.md §6). */
  'aria-label': string
}

/** Square icon-only button. Same variants and states as `Button`. */
export function IconButton({ icon, ...props }: IconButtonProps) {
  // Routed through `icon` (not children) so `loading` swaps the glyph for the
  // spinner instead of showing both.
  return <Button {...props} iconOnly icon={icon} />
}
