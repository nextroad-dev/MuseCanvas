import type { ReactNode } from 'react'
import { TrayIcon as Inbox } from '@phosphor-icons/react/ssr'
import type { Icon as PhosphorIcon } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { Button } from './button'
import type { ButtonVariant } from './button'
import { iconSize } from './size'

export interface EmptyStateProps {
  /** Defaults to an inbox glyph; pass a domain glyph when the object is concrete. */
  icon?: PhosphorIcon
  title: ReactNode
  description?: ReactNode
  /** Full control of the action slot. */
  action?: ReactNode
  /** Convenience: renders a `<Button>` with `actionLabel`. */
  onAction?: () => void
  actionLabel?: ReactNode
  actionVariant?: ButtonVariant
  /** Extra content under the action (secondary link, shortcut hint). */
  children?: ReactNode
  /** `compact` fits inside a panel or an empty table body. */
  density?: 'comfortable' | 'compact'
  /** Override the icon tone; defaults to secondary text. */
  iconClassName?: string
  className?: string
}

/**
 * 空状态：图标 + 标题 + 简短说明 + 恰好一个与原因匹配的操作。虚线容器只保留给
 * 上传/拖拽语义，这里绝不使用。
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  onAction,
  actionLabel,
  actionVariant = 'secondary',
  children,
  density = 'comfortable',
  iconClassName,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 px-4 text-center text-foreground',
        density === 'comfortable' ? 'py-12' : 'py-6',
        className,
      )}
    >
      <Icon weight="duotone" aria-hidden="true" className={cn(iconSize['2xl'], 'text-muted-foreground', iconClassName)} />
      <div className="flex flex-col gap-1">
        <p className="text-module">{title}</p>
        {description ? <p className="max-w-reading text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
      {!action && onAction ? (
        <Button variant={actionVariant} size="sm" onClick={onAction}>
          {actionLabel ?? '重试'}
        </Button>
      ) : null}
      {children}
    </div>
  )
}
