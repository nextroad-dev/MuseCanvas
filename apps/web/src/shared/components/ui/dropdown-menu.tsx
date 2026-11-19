'use client'

import { Children, Fragment, cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { exitDurationMs } from '@/shared/lib/motion'
import { controlMinHeight, iconSlot, touchTarget } from './size'

export interface DropdownMenuItem {
  /** Stable key. Defaults to the array index. */
  id?: string
  label: ReactNode
  /** Leading icon; the recipe sizes the slot. */
  icon?: ReactNode
  onSelect?: () => void
  /** Destructive entry: danger text on a `danger-soft` wash, never a red solid. */
  danger?: boolean
  /** `aria-disabled` + `.is-disabled`, kept out of the roving sequence. */
  disabled?: boolean
  /** Highlight as the currently active option. */
  selected?: boolean
  /** Draw a separator rule before this item (grouping). */
  separator?: boolean
}

export interface DropdownMenuProps {
  /** Single element cloned with the menu trigger props; it owns its accessible name. */
  trigger: ReactElement
  items: DropdownMenuItem[]
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end'
  /** Vertical placement relative to the trigger. */
  side?: 'bottom' | 'top'
  /** Free node above the items (the signed-in address, a summary line…). */
  header?: ReactNode
  /** Accessible name of the `role="menu"` panel. */
  menuLabel?: string
  /** Item hit targets: 36px (default) or 32px dense. */
  size?: 'sm' | 'md'
  /** Class for the positioning wrapper. */
  className?: string
  /** Class for the panel (width, padding). */
  menuClassName?: string
  /** Controlled visibility; omit and the menu owns its state. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** How the trigger opens the menu: `'click'` (default) or `'hover'`. */
  triggerMode?: 'click' | 'hover'
}

const ITEM_BASE = [
  'flex w-full shrink-0 select-none items-center gap-2 whitespace-nowrap rounded-control px-3',
  'text-left text-sm text-foreground',
  `${iconSlot.sm} [&>svg]:shrink-0`,
  'transition-colors',
].join(' ')

const ITEM_TONE = {
  default: 'not-disabled:hover:bg-tonal not-disabled:active:bg-tonal-active',
  danger: 'text-danger not-disabled:hover:bg-danger-soft',
} as const

const ITEM_SIZE = {
  sm: `${controlMinHeight.sm} ${touchTarget}`,
  md: `${controlMinHeight.md} ${touchTarget}`,
} as const

export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  side = 'bottom',
  header,
  menuLabel,
  size = 'md',
  className,
  menuClassName,
  open,
  onOpenChange,
  triggerMode = 'click',
}: DropdownMenuProps) {
  const uid = useId()
  const panelId = `${uid}-menu`
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const itemRefs = useRef(new Map<number, HTMLButtonElement | null>())
  const hoverCloseTimerRef = useRef<number | null>(null)
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = open ?? internalOpen
  const [mounted, setMounted] = useState(isOpen)
  const [closing, setClosing] = useState(false)

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next)
      onOpenChange?.(next)
    },
    [open, onOpenChange],
  )

  useEffect(() => {
    if (isOpen) {
      setClosing(false)
      setMounted(true)
      return
    }
    if (mounted) setClosing(true)
  }, [isOpen, mounted])

  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => {
      setClosing(false)
      setMounted(false)
    }, exitDurationMs())
    return () => window.clearTimeout(timer)
  }, [closing])

  const close = useCallback(
    (restoreFocus: boolean) => {
      setOpen(false)
      if (restoreFocus) triggerRef.current?.focus()
    },
    [setOpen],
  )

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current)
      hoverCloseTimerRef.current = null
    }
  }, [])

  const scheduleHoverClose = useCallback(() => {
    clearHoverCloseTimer()
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null
      setOpen(false)
    }, 120)
  }, [clearHoverCloseTimer, setOpen])

  useEffect(() => clearHoverCloseTimer, [clearHoverCloseTimer])

  useEffect(() => {
    if (!isOpen || !mounted || closing || triggerMode === 'hover') return
    const firstIndex = items.findIndex((item) => !item.disabled)
    if (firstIndex >= 0) itemRefs.current.get(firstIndex)?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mounted, closing, triggerMode])

  useEffect(() => {
    if (!isOpen) return
    function onPointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (wrapperRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [isOpen, setOpen])

  function activate(index: number) {
    const item = items[index]
    if (!item || item.disabled) return
    clearHoverCloseTimer()
    setOpen(false)
    if (triggerMode !== 'hover') triggerRef.current?.focus()
    item.onSelect?.()
  }

  const enabledIndexes = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0)

  function focusItem(index: number) {
    if (enabledIndexes.length === 0) return
    const position = ((index % enabledIndexes.length) + enabledIndexes.length) % enabledIndexes.length
    itemRefs.current.get(enabledIndexes[position])?.focus()
  }

  function currentIndex(): number {
    const active = document.activeElement
    if (!active) return -1
    return enabledIndexes.findIndex((index) => itemRefs.current.get(index) === active)
  }

  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusItem(currentIndex() + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusItem(currentIndex() - 1)
        break
      case 'Home':
        event.preventDefault()
        focusItem(0)
        break
      case 'End':
        event.preventDefault()
        focusItem(-1)
        break
      case 'Escape':
      case 'Tab':
        event.preventDefault()
        close(true)
        break
      default:
        break
    }
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && isOpen) {
      event.preventDefault()
      close(true)
      return
    }
    if (isOpen || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    event.preventDefault()
    setOpen(true)
  }

  const triggerElement = Children.only(trigger)
  if (!isValidElement(triggerElement)) {
    throw new Error('DropdownMenu: `trigger` must be a single React element.')
  }

  const isTriggerDisabled = Boolean((triggerElement.props as { disabled?: boolean }).disabled)

  const clonedTrigger = cloneElement(triggerElement as ReactElement<Record<string, unknown>>, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
    },
    'aria-haspopup': 'menu',
    'aria-expanded': isOpen,
    'aria-controls': mounted ? panelId : undefined,
    onClick: (event: unknown) => {
      const original = (triggerElement.props as { onClick?: (e: unknown) => void }).onClick
      original?.(event)
      if (triggerMode === 'click') setOpen(!isOpen)
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      const original = (triggerElement.props as { onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void }).onKeyDown
      original?.(event)
      if (event.defaultPrevented) return
      onTriggerKeyDown(event)
    },
  })

  return (
    <div
      ref={wrapperRef}
      className={cn('relative inline-flex', className)}
      onMouseEnter={
        triggerMode === 'hover'
          ? () => {
              if (isTriggerDisabled) return
              clearHoverCloseTimer()
              setOpen(true)
            }
          : undefined
      }
      onMouseLeave={triggerMode === 'hover' ? scheduleHoverClose : undefined}
    >
      {clonedTrigger}

      {mounted ? (
        <div
          id={panelId}
          role="menu"
          aria-label={menuLabel}
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
          className={cn(
            'absolute z-dropdown flex w-56 flex-col gap-0.5 rounded-popover border border-border bg-surface p-1.5 shadow-dropdown',
            side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
            align === 'end' ? 'right-0' : 'left-0',
            side === 'top'
              ? align === 'end'
                ? 'origin-bottom-right'
                : 'origin-bottom-left'
              : align === 'end'
                ? 'origin-top-right'
                : 'origin-top-left',
            closing ? 'pointer-events-none motion-fade-out' : 'motion-menu',
            menuClassName,
          )}
        >
          {header}
          {items.map((item, index) => (
            <Fragment key={item.id ?? index}>
              {item.separator ? <div aria-hidden="true" className="my-1 h-px bg-border" /> : null}
              <button
                ref={(node) => {
                  itemRefs.current.set(index, node)
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.disabled || undefined}
                disabled={item.disabled}
                onClick={() => activate(index)}
                className={cn(
                  ITEM_BASE,
                  ITEM_SIZE[size],
                  ITEM_TONE[item.danger ? 'danger' : 'default'],
                  item.selected && !item.danger && 'bg-tonal-selected font-medium text-foreground',
                  item.disabled && 'is-disabled',
                )}
              >
                {item.icon}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  )
}
