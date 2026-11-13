import { cva, type VariantProps } from 'class-variance-authority'
import { controlMinHeight, controlSquare, iconSlot, touchTarget, touchTargetSquare } from './size'

export type ButtonVariant = NonNullable<VariantProps<typeof buttonCva>['variant']>
export type ButtonSize = NonNullable<VariantProps<typeof buttonCva>['size']>

/**
 * 唯一的按钮配方。
 *
 * · primary 黑底（品牌绿只用于 logo/状态）；secondary 弱色块；ghost 透明工具按钮；
 *   danger 仅用于破坏性确认；danger-ghost 用于取消/中止；outline 带描边的中性
 *   操作；link 像链接的行内文本操作。
 * · 尺寸通过 `min-h` 走 `--control-*` 阶梯，缩放/换行只会撑高不会裁切；`icon` 为
 *   方形纯图标尺寸，移动端自动补到 44px 触控下限。
 * · 焦点环由 globals.css 统一提供；按压/颜色动效来自 `.motion-press`。
 * · hover 守卫用 `:not(:disabled)` 而不是 `enabled:`，因为 `<a>` 也会穿这套配方。
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
        danger: 'bg-danger text-on-danger',
        'danger-ghost': 'bg-transparent text-danger',
        outline: 'border border-border-control bg-transparent text-foreground',
        link: 'bg-transparent text-foreground underline-offset-4',
      },
      size: {
        sm: `${controlMinHeight.sm} ${touchTarget} gap-1.5 px-3`,
        md: `${controlMinHeight.md} ${touchTarget} gap-2 px-4`,
        lg: `${controlMinHeight.lg} gap-2 px-5 ${iconSlot.md}`,
        icon: `${controlSquare.md} ${touchTargetSquare} gap-0 p-0`,
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
      { variant: 'primary', state: 'idle', className: 'not-disabled:hover:bg-primary-hover not-disabled:active:bg-primary-active' },
      { variant: 'secondary', state: 'idle', className: 'not-disabled:hover:bg-tonal-hover not-disabled:active:bg-tonal-active' },
      // ghost / danger-ghost 的 scrim 用 `--opacity-ghost-*`，token 已按主题翻转，
      // 一套类名同时覆盖浅色与深色。
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
      {
        variant: 'outline',
        state: 'idle',
        className: 'not-disabled:hover:border-border-strong not-disabled:hover:bg-tonal not-disabled:active:bg-tonal-active',
      },
      { variant: 'link', state: 'idle', className: 'not-disabled:hover:underline' },
      // 忙碌态优先于 hover：请求进行中颜色保持不变。
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
 * 只产出类名的逃生口：真实 `<Link>` 可以穿按钮样式而不承担 button 语义。
 * 放在无 `'use client'` 的模块里，RSC 也能调用。
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
 * 安静的方形图标按钮：次级文字色，hover/按压时铺一层弱色块。用于对话框关闭、
 * toast 关闭与主题切换等“工具”位，语气比 `ghost` 按钮更轻。
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
