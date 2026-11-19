import { cva, type VariantProps } from 'class-variance-authority'
import { controlMinHeight, controlSquare, iconSlot, touchTarget, touchTargetSquare } from './size'

export type ButtonVariant = NonNullable<VariantProps<typeof buttonCva>['variant']>
export type ButtonSize = NonNullable<VariantProps<typeof buttonCva>['size']>

/**
 * 全站唯一按钮配方：
 * - 统一 `rounded-control`（10px）与 4 档控件高度（xs 28 / sm 32 / md 36 默认 / lg 44）
 * - 所有实底与透明变体均自带 1px 透明或语义描边，保证并排按钮像素级等高
 * - 按压与颜色过渡由 `.motion-press` 统一承载，焦点环由 globals.css 提供
 */
const buttonCva = cva(
  [
    'relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap',
    'rounded-control font-medium',
    `${iconSlot.sm} [&>svg]:shrink-0`,
    'motion-press',
  ].join(' '),
  {
    variants: {
      variant: {
        primary: 'border border-transparent bg-primary text-on-primary',
        secondary: 'border border-border bg-tonal text-foreground',
        outline: 'border border-border-control bg-surface text-foreground',
        ghost: 'border border-transparent bg-transparent text-foreground',
        danger: 'border border-transparent bg-danger text-on-danger',
        'danger-ghost': 'border border-transparent bg-transparent text-danger',
        link: 'border-0 bg-transparent text-foreground underline-offset-4',
      },
      size: {
        xs: `${controlMinHeight.xs} gap-1 px-2.5 text-xs`,
        sm: `${controlMinHeight.sm} ${touchTarget} gap-1.5 px-3 text-ui`,
        md: `${controlMinHeight.md} ${touchTarget} gap-1.5 px-3.5 text-sm`,
        lg: `${controlMinHeight.lg} gap-2 px-5 text-sm ${iconSlot.md}`,
        icon: `${controlSquare.md} ${touchTargetSquare} gap-0 p-0 text-sm`,
        'icon-sm': `${controlSquare.sm} ${touchTargetSquare} gap-0 p-0 text-ui`,
        'icon-xs': `${controlSquare.xs} gap-0 p-0 text-xs`,
      },
      state: {
        idle: '',
        busy: '',
      },
      fullWidth: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md', state: 'idle', fullWidth: false },
    compoundVariants: [
      {
        variant: 'primary',
        state: 'idle',
        className: 'not-disabled:hover:bg-primary-hover not-disabled:active:bg-primary-active',
      },
      {
        variant: 'secondary',
        state: 'idle',
        className:
          'not-disabled:hover:border-border-control not-disabled:hover:bg-tonal-hover not-disabled:active:bg-tonal-active',
      },
      {
        variant: 'outline',
        state: 'idle',
        className:
          'not-disabled:hover:border-border-strong not-disabled:hover:bg-surface-hover not-disabled:active:bg-tonal',
      },
      {
        variant: 'ghost',
        state: 'idle',
        className: 'not-disabled:hover:bg-tonal not-disabled:active:bg-tonal-active',
      },
      {
        variant: 'danger',
        state: 'idle',
        className: 'not-disabled:hover:bg-danger-hover not-disabled:active:bg-danger-active',
      },
      {
        variant: 'danger-ghost',
        state: 'idle',
        className: 'not-disabled:hover:bg-danger-soft not-disabled:active:bg-danger-soft',
      },
      { variant: 'link', state: 'idle', className: 'not-disabled:hover:underline' },
      { state: 'busy', className: 'pointer-events-none' },
    ],
  },
)

export interface ButtonVariantProps {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  /** Busy paint: hover/active are suppressed while a request runs. */
  loading?: boolean
  className?: string
}

/**
 * 纯类名配方逃生口：`<Link>` 等导航元素可套用按钮样式而不承担 `<button>` 语义。
 * 无 `'use client'`，可在 Server Component 中直接调用。
 */
export function buttonVariants({
  variant = 'primary',
  size = 'md',
  fullWidth,
  loading,
  className,
}: ButtonVariantProps = {}): string {
  return buttonCva({ variant, size, fullWidth, state: loading ? 'busy' : 'idle', className })
}

/**
 * 安静的方形图标工具按钮（关闭对话框 / 折叠侧栏 / 主题切换）。
 */
export const ghostIconButtonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center rounded-control text-muted-foreground',
    'not-disabled:hover:bg-tonal not-disabled:hover:text-foreground not-disabled:active:bg-tonal-active',
    'motion-press',
  ].join(' '),
  {
    variants: {
      size: {
        xs: controlSquare.xs,
        sm: controlSquare.sm,
        md: controlSquare.md,
      },
    },
    defaultVariants: { size: 'sm' },
  },
)
