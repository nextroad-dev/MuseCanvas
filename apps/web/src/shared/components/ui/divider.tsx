import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/shared/lib/cn'

export interface DividerProps extends Omit<HTMLAttributes<HTMLHRElement>, 'children'> {
  /** Optional label centred on the rule, in caption size + secondary colour. */
  label?: ReactNode
  /** Escape hatch for the label chip (match its background to the container). */
  labelClassName?: string
  ref?: Ref<HTMLHRElement>
}

/**
 * Section divider. Scope is page-level blocks, settings groups, table rows and
 * toolbar groups — it must NEVER appear inside a `Card`: content cards separate
 * header/body/footer with spacing and heading level only, no `<hr>`, no
 * `border-t`/`border-b`, no `divide-*` (components.md 展示与内容 + verification
 * checklist “内容卡片内部没有分割线”).
 *
 * The label rides over the rule, so its chip background defaults to `bg-surface`;
 * pass `labelClassName` (e.g. `bg-canvas`) on a non-white container.
 */
export function Divider({ label, className, labelClassName, ref, ...rest }: DividerProps) {
  if (!label) {
    return <hr ref={ref} className={cn('border-0 border-t border-border', className)} {...rest} />
  }

  return (
    <div className={cn('relative', className)}>
      <hr ref={ref} className="border-0 border-t border-border" {...rest} />
      <span
        className={cn(
          'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface px-2 text-xs text-muted-foreground',
          labelClassName,
        )}
      >
        {label}
      </span>
    </div>
  )
}
