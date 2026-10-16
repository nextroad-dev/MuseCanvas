'use client'

import { useCallback, useEffect, useId } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { PlusIcon, XIcon } from '@phosphor-icons/react'
import type { CanvasListItemDto } from '@musecanvas/contracts'
import { Alert, Button, IconButton, iconSize } from '@/shared/components/ui'
import { useDialog } from '@/shared/hooks/useDialog'
import { cn } from '@/shared/lib/cn'

export interface ConversationSidebarProps {
  items: CanvasListItemDto[]
  currentCanvasId: string | null
  loading: boolean
  error: unknown
  hasMore: boolean
  onLoadMore: () => void
  onSelect: (canvasId: string) => void
  onCreate: () => void
  creating: boolean
  /** Mobile drawer (small screens). On large screens the rail is always docked. */
  open: boolean
  onClose: () => void
}

/** Cells past this index share one delay, matching the library grid's clamp. */
const STAGGER_CLAMP = 8

/** Scrim: `--color-overlay` at `--opacity-overlay` (40% light, 55% dark). */
const SCRIM_BACKGROUND = 'color-mix(in srgb, var(--color-overlay) calc(var(--opacity-overlay) * 100%), transparent)'

/** Below `lg` the docked rail is gone, so a lingering mobile drawer must close. */
const DESKTOP_BREAKPOINT_QUERY = '(min-width: 64rem)'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '对话列表加载失败'
}

/**
 * Conversation list. Docked as a rail at `lg` and above, separated from the
 * timeline by a single rule rather than a box; on smaller screens it becomes a
 * dismissible drawer so the timeline keeps the full width. Creating a conversation
 * happens only on an explicit "new conversation" action.
 */
export function ConversationSidebar({
  items,
  currentCanvasId,
  loading,
  error,
  hasMore,
  onLoadMore,
  onSelect,
  onCreate,
  creating,
  open,
  onClose,
}: ConversationSidebarProps) {
  const current = items.find((item) => item.id === currentCanvasId) ?? null
  const headingId = useId()
  const closeDrawer = useCallback(() => onClose(), [onClose])
  const {
    mounted: drawerMounted,
    phase: drawerPhase,
    closeButtonRef: drawerCloseButtonRef,
    portalTarget: drawerPortalTarget,
    rootProps: drawerRootProps,
    dialogProps: drawerDialogProps,
  } = useDialog({ open, onClose: closeDrawer })

  // The rail docks at `lg`: reaching it retires the overlay drawer instead of
  // leaving an invisible open dialog behind.
  useEffect(() => {
    const breakpoint = window.matchMedia(DESKTOP_BREAKPOINT_QUERY)
    const closeOnDesktop = () => {
      if (breakpoint.matches) closeDrawer()
    }
    breakpoint.addEventListener('change', closeOnDesktop)
    return () => breakpoint.removeEventListener('change', closeOnDesktop)
  }, [closeDrawer])

  const content = (
    <nav aria-label="对话列表" className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-module text-foreground">对话</h2>
        <div className="flex items-center gap-1">
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="新建对话"
            loading={creating}
            onClick={onCreate}
            icon={<PlusIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
          />
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="关闭对话列表"
            className="lg:hidden"
            ref={drawerCloseButtonRef}
            onClick={onClose}
            icon={<XIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
          />
        </div>
      </div>
      {error ? <Alert tone="warning" title="对话列表刷新失败">{errorMessage(error)}</Alert> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">{loading ? '正在加载对话…' : '还没有对话，新建一个开始创作。'}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map((item, index) => {
              const active = item.id === currentCanvasId
              return (
                <li
                  key={item.id}
                  className="motion-reveal motion-stagger"
                  style={{ '--stagger-index': String(Math.min(index, STAGGER_CLAMP)) } as CSSProperties}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    fullWidth
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onSelect(item.id)}
                    className={cn(
                      'justify-start px-2 font-normal',
                      active ? 'bg-tonal-selected text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {active ? <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-[3px] rounded-pill bg-primary" /> : null}
                    <span className="min-w-0 flex-1 truncate text-left">{item.title || '未命名画布'}</span>
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
        {hasMore ? (
          <Button variant="ghost" size="sm" fullWidth className="mt-2" onClick={onLoadMore}>
            加载更多
          </Button>
        ) : null}
      </div>
      {current ? (
        <p className="shrink-0 truncate border-t border-border pt-3 text-xs text-muted-foreground" title={current.title}>
          当前：{current.title || '未命名画布'}
        </p>
      ) : null}
    </nav>
  )

  return (
    <>
      <aside className="hidden lg:flex lg:w-[var(--container-settings-nav)] lg:shrink-0 lg:flex-col lg:border-r lg:border-border lg:pr-6">
        {content}
      </aside>
      {drawerMounted && drawerPortalTarget ? createPortal(
        <div
          {...drawerRootProps}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDrawer()
          }}
          className={cn(
            'fixed inset-0 z-modal lg:hidden',
            drawerPhase === 'close' ? 'motion-fade-out pointer-events-none' : 'motion-fade-in',
          )}
        >
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{ backgroundColor: SCRIM_BACKGROUND }}
            onClick={closeDrawer}
          />
          <div
            {...drawerDialogProps}
            aria-labelledby={headingId}
            className={cn(
              'absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col bg-surface p-4 shadow-drawer',
              drawerPhase === 'close' ? 'motion-drawer-out-left' : 'motion-drawer-in-left',
            )}
          >
            {content}
          </div>
        </div>,
        drawerPortalTarget,
      ) : null}
    </>
  )
}
