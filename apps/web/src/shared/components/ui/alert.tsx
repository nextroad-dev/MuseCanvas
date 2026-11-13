import type { ReactNode } from 'react'
import {
  WarningCircleIcon as CircleAlert,
  CheckCircleIcon as CircleCheck,
  InfoIcon as InfoIcon,
  WarningIcon as TriangleAlert,
  XIcon as X,
} from '@phosphor-icons/react/ssr'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { IconButton } from './button'
import { iconSize, iconSlot } from './size'

export type AlertTone = 'info' | 'success' | 'warning' | 'danger'

const toneClasses: Record<AlertTone, { wrap: string; icon: string }> = {
  // 纯色横幅：1px 语义描边 + `-soft` 底色，不用左侧装饰竖条。
  info: { wrap: 'border-info-border bg-info-soft', icon: 'text-info' },
  success: { wrap: 'border-success-border bg-success-soft', icon: 'text-success' },
  warning: { wrap: 'border-warning-border bg-warning-soft', icon: 'text-warning' },
  danger: { wrap: 'border-danger-border bg-danger-soft', icon: 'text-danger' },
}

const toneIcons: Record<AlertTone, PhosphorIcon> = {
  info: InfoIcon,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
}

export interface AlertProps {
  tone?: AlertTone
  title?: ReactNode
  /** Body copy: keep it to the fix, not just the failure. */
  children?: ReactNode
  /** Action node placed after the text, e.g. a `<Button size="sm">`. */
  action?: ReactNode
  /** Renders the close button; without it the banner stays until the data changes. */
  onDismiss?: () => void
  dismissLabel?: string
  /** `false` drops the leading icon; pass a node to replace it. */
  icon?: ReactNode | false
  /**
   * `status`（默认）是 polite 直播区；`alert` 会抢占播报，只在紧急信息时开启。
   */
  role?: 'status' | 'alert'
  className?: string
}

/** Banner / callout: in-flow full-width block, never a floating layer. */
export function Alert({
  tone = 'info',
  title,
  children,
  action,
  onDismiss,
  dismissLabel = '关闭提示',
  icon,
  role = 'status',
  className,
}: AlertProps) {
  const Icon = toneIcons[tone]
  const shownIcon = icon === false ? null : (icon ?? <Icon weight="fill" aria-hidden="true" className={iconSize.md} />)

  return (
    <div role={role} className={cn('flex items-start gap-3 rounded-control border p-4', toneClasses[tone].wrap, className)}>
      {shownIcon ? (
        <span className={cn('mt-0.5 shrink-0', iconSlot.md, toneClasses[tone].icon)}>{shownIcon}</span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title ? <p className="text-sm font-medium text-foreground">{title}</p> : null}
        {children ? <div className="text-sm text-muted-foreground">{children}</div> : null}
        {action ? <div className="mt-2 flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {onDismiss ? (
        <IconButton
          variant="ghost"
          size="icon"
          aria-label={dismissLabel}
          onClick={onDismiss}
          icon={<X weight="bold" aria-hidden="true" className={iconSize.sm} />}
        />
      ) : null}
    </div>
  )
}
