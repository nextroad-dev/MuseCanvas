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
  /** Leading icon. Swapped for the spinner while `loading`, so the slot never moves. */
  icon?: ReactNode
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
 * Button：应用的主操作控件。
 *
 * 静态按钮与链接不创建事件处理器，保持 RSC 可用；交互守卫由小型 Client Island 承接。
 * 配方、焦点环、禁用态与按压动效共享，图标/加载态互换及 `asChild` 转交在此完成。
 */
export function Button({
  variant = 'primary',
  size = 'md',
  icon,
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
    const childBlocked = Boolean(disabled || blocked || child.props.disabled || child.props['aria-disabled'] === true || child.props['aria-disabled'] === 'true')
    const element = cloneElement(child, {
      ...rest,
      className: cn(classes, childProps.className),
      'aria-disabled': childBlocked || undefined,
      'aria-busy': loading || undefined,
    })
    return childBlocked || onClick || childProps.onClick ? (
      <ButtonInteraction blocked={childBlocked} onClick={onClick}>{element}</ButtonInteraction>
    ) : element
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
      {loading ? <Spinner size={size === 'lg' ? 'md' : 'sm'} /> : icon}
      {children}
    </button>
  )
  return blocked || onClick ? (
    <ButtonInteraction blocked={Boolean(disabled || blocked)} onClick={onClick}>{element}</ButtonInteraction>
  ) : element
}

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'asChild'> {
  icon: ReactNode
  /** Required: an icon-only control has no text to derive a name from. */
  'aria-label': string
}

/** 方形纯图标按钮：变体、状态与可访问名称规则同 `Button`。 */
export function IconButton({ icon, size = 'icon', ...props }: IconButtonProps) {
  return <Button {...props} size={size} icon={icon} />
}
