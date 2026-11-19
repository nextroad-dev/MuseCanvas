import { cloneElement, isValidElement } from 'react'
import type {
  ButtonHTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
  Ref,
} from 'react'
import { cn } from '@/shared/lib/cn'
import { buttonVariants } from './button-variants'
import type { ButtonSize, ButtonVariant } from './button-variants'
import { Spinner } from './spinner'
import { ButtonInteraction } from './button-interaction'

export { buttonVariants, ghostIconButtonVariants } from './button-variants'
export type { ButtonSize, ButtonVariant, ButtonVariantProps } from './button-variants'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'ref'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Leading icon slot (preferred). Swapped for Spinner while `loading`. */
  leadingIcon?: ReactNode
  /** Backwards-compatible alias for `leadingIcon`. */
  icon?: ReactNode
  /** Trailing icon slot (e.g. directional next arrow). */
  trailingIcon?: ReactNode
  /** Async in flight: label stays visible, `aria-busy` is set, repeat activation is blocked. */
  loading?: boolean
  fullWidth?: boolean
  /**
   * 把按钮配方套在单个子元素上（如导航 `<Link>`），而不是渲染 `<button>`。
   * 子元素保留自己的 `onClick`；禁用/忙碌时阻止所有点击回调。
   */
  asChild?: boolean
  ref?: Ref<HTMLButtonElement>
}

/**
 * Button：应用的主操作控件（保持 RSC-safe，无 `'use client'`）。
 *
 * 静态按钮与链接不创建事件处理器；需要交互或点击拦截时，由 `ButtonInteraction`
 * Client Island 承接。
 */
export function Button({
  variant = 'primary',
  size = 'md',
  leadingIcon,
  icon,
  trailingIcon,
  loading = false,
  fullWidth,
  asChild = false,
  className,
  disabled,
  onClick,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const startIcon = leadingIcon ?? icon
  const ariaDisabled = rest['aria-disabled'] === true || rest['aria-disabled'] === 'true'
  const blocked = loading || ariaDisabled
  const classes = cn(
    buttonVariants({ variant, size, fullWidth, loading }),
    (disabled || ariaDisabled) && 'is-disabled',
    loading && 'cursor-wait',
    className,
  )

  if (asChild) {
    if (!isValidElement(children)) {
      throw new Error('Button: `asChild` needs exactly one child element.')
    }
    const child = children as ReactElement<Record<string, unknown>>
    const childProps = child.props as { className?: string; onClick?: (event: ReactMouseEvent<HTMLElement>) => void }
    const childBlocked = Boolean(
      disabled ||
        blocked ||
        child.props.disabled ||
        child.props['aria-disabled'] === true ||
        child.props['aria-disabled'] === 'true',
    )
    const element = cloneElement(child, {
      ...rest,
      className: cn(classes, childProps.className),
      'aria-disabled': childBlocked || undefined,
      'aria-busy': loading || undefined,
    })
    return childBlocked || onClick || childProps.onClick ? (
      <ButtonInteraction blocked={childBlocked} onClick={onClick}>
        {element}
      </ButtonInteraction>
    ) : (
      element
    )
  }

  const element = (
    <button
      type="button"
      {...rest}
      ref={ref}
      disabled={disabled}
      aria-disabled={ariaDisabled || undefined}
      aria-busy={loading || undefined}
      className={classes}
    >
      {loading ? <Spinner size={size === 'lg' ? 'md' : 'sm'} /> : startIcon}
      {children}
      {trailingIcon}
    </button>
  )
  return blocked || onClick ? (
    <ButtonInteraction blocked={Boolean(disabled || blocked)} onClick={onClick}>
      {element}
    </ButtonInteraction>
  ) : (
    element
  )
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'leadingIcon' | 'trailingIcon' | 'asChild'> {
  icon: ReactNode
  /** Required: an icon-only control has no text to derive a name from. */
  'aria-label': string
}

/** 方形纯图标按钮：变体、状态与可访问名称规则同 `Button`。 */
export function IconButton({ icon, size = 'icon', ...props }: IconButtonProps) {
  return <Button {...props} size={size} leadingIcon={icon} />
}
