import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/shared/lib/cn'

export interface DividerProps extends Omit<HTMLAttributes<HTMLHRElement>, 'children'> {
  /** Optional label centred on the rule, in caption size + secondary colour. */
  label?: ReactNode
  /** Escape hatch for the label chip (match its background to the container). */
  labelClassName?: string
  /** `horizontal` (default) draws a rule; `vertical` separates toolbar groups. */
  orientation?: 'horizontal' | 'vertical'
  ref?: Ref<HTMLHRElement>
}

/**
 * 分隔线：页面级区块、设置分组、表格行、工具栏分组。不在内容卡片内部出现——
 * 卡片用留白分区。
 */
export function Divider({ label, labelClassName, orientation = 'horizontal', className, ref, ...rest }: DividerProps) {
  if (orientation === 'vertical') {
    return <hr ref={ref} aria-orientation="vertical" className={cn('h-full border-0 border-l border-border', className)} {...rest} />
  }

  if (!label) {
    return <hr ref={ref} className={cn('border-0 border-t border-border', className)} {...rest} />
  }

  return (
    <div className={cn('relative text-muted-foreground', className)}>
      <hr ref={ref} className="border-0 border-t border-border" {...rest} />
      <span
        className={cn(
          'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface px-2 text-caption',
          labelClassName,
        )}
      >
        {label}
      </span>
    </div>
  )
}
