'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import Link from 'next/link'
import { cn } from '@/shared/lib/cn'
import { exitDurationMs } from '@/shared/lib/motion'
import { Spinner } from './spinner'
import { iconSlot } from './size'

export interface DropdownMenuItem {
  id: string
  label: ReactNode
  /** Leading icon. Sized by the item recipe, so callers pass a bare glyph. */
  icon?: ReactNode
  /**
   * Renders the item as a real link — components.md 通用: 导航用链接、动作用
   * button. An `href` item still closes the menu and returns focus.
   */
  href?: string
  onSelect?: () => void
  /** Destructive entry: danger text on a danger-soft wash, never a red solid. */
  danger?: boolean
  /** `aria-disabled` + `.is-disabled`, kept out of the roving sequence. */
  disabled?: boolean
  /** Async in flight: the icon slot becomes a spinner, repeat activation is blocked. */
  loading?: boolean
}

export interface DropdownMenuProps {
  /** Trigger contents (an icon, an `Avatar`…). Wrapped in the `<button>` this owns. */
  trigger: ReactNode
  /** Accessible name for the trigger button — it has no label text of its own. */
  triggerLabel: string
  /** Shape/surface of the trigger; the menu stays presentation-neutral. */
  triggerClassName?: string
  items: DropdownMenuItem[]
  /** Free node above the items (the signed-in address, a summary line…). */
  header?: ReactNode
  /** Grouped menu: an overline heading between `header` and the items. */
  overline?: string
  /** Accessible name of the `role="menu"` panel. Defaults to `triggerLabel`. */
  menuLabel?: string
  /** Item hit targets: 40px (default) or 32px dense. Labels stay 14px either way. */
  size?: 'sm' | 'md'
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end'
  /** Class for the wrapper (positioning) — the wrapper is `relative`. */
  className?: string
  /** Class for the panel, e.g. a wider menu (`w-56` is the default). */
  menuClassName?: string
  /** Controlled visibility; omit both and the menu owns its state. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

const ITEM_BASE = [
  'flex w-full shrink-0 select-none items-center gap-2 whitespace-nowrap rounded-control px-3',
  'text-left text-sm text-foreground',
  `${iconSlot.sm} [&>svg]:shrink-0`,
  'transition-colors',
].join(' ')

const ITEM_TONE = {
  default: 'not-disabled:hover:bg-tonal-hover not-disabled:active:bg-tonal-active',
  danger: 'text-danger not-disabled:hover:bg-danger-soft not-disabled:active:bg-danger-border',
} as const

const ITEM_SIZE = {
  sm: 'h-[var(--control-sm)] min-h-[var(--control-sm)]',
  md: 'h-[var(--control-md)] min-h-[var(--control-md)]',
} as const

/**
 * The app's action menu, single-sourced (components.md Dropdown menu row):
 * a `button` trigger carrying `aria-haspopup="menu"` / `aria-expanded`, a
 * `role="menu"` panel of `role="menuitem"` entries, ArrowUp/Down/Home/End roving
 * focus with wrap, Enter/Space activation, Escape and outside `pointerdown`
 * closing with the focus handed back to the trigger.
 *
 * Surface is `rounded-popover` + `shadow-dropdown` at `z-dropdown` — the popup
 * radius and the dropdown rung of the elevation ladder, not the modal one. The
 * panel enters on `.motion-menu` (`--motion-base`) and leaves on `.motion-fade-out`
 * (`--motion-exit`, faster than the entrance, per globals.css).
 *
 * Initial focus is set synchronously in the effect after the panel commits:
 * a `requestAnimationFrame` hand-off would strand focus (and the whole open) in a
 * background or hidden tab, where frames are never produced.
 */
export function DropdownMenu({
  trigger,
  triggerLabel,
  triggerClassName,
  items,
  header,
  overline,
  menuLabel,
  size = 'md',
  align = 'end',
  className,
  menuClassName,
  open,
  onOpenChange,
}: DropdownMenuProps) {
  const uid = useId()
  const panelId = `${uid}-menu`
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef(new Map<string, HTMLElement | null>())
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = open ?? internalOpen
  // `mounted` trails `isOpen` by the exit animation, so the panel is still on
  // screen while it fades instead of vanishing on unmount.
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

  // Teardown runs for the exit token's duration (`--motion-exit`), read at runtime.
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => {
      setClosing(false)
      setMounted(false)
    }, exitDurationMs())
    return () => window.clearTimeout(timer)
  }, [closing])

  const enabledItems = items.filter((item) => !item.disabled)

  function focusItem(index: number) {
    if (enabledItems.length === 0) return
    const target = enabledItems[(index + enabledItems.length) % enabledItems.length]
    itemRefs.current.get(target.id)?.focus()
  }

  const close = useCallback(
    (restoreFocus: boolean) => {
      setOpen(false)
      if (restoreFocus) triggerRef.current?.focus()
    },
    [setOpen],
  )

  // Open → focus the first entry, so the keyboard never has to guess that the
  // panel appeared somewhere reachable. `mounted` is a dependency on purpose: the
  // render that flips `isOpen` does not have a panel in the DOM yet, and keying on
  // the open transition alone would run this once against an empty ref map.
  // Deliberately *not* keyed on `items`: a re-render while the menu is up (a
  // mutation flipping to busy) must not yank focus back to the top of the list.
  useEffect(() => {
    if (!isOpen || !mounted || closing) return
    const first = items.find((item) => !item.disabled)
    if (first) itemRefs.current.get(first.id)?.focus()
  }, [isOpen, mounted, closing])

  // Click / tap outside. A document listener, not a full-viewport catcher div:
  // the catcher would need its own stacking level under the ladder.
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

  function activate(item: DropdownMenuItem) {
    if (item.disabled || item.loading) return
    setOpen(false)
    item.onSelect?.()
  }

  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const current = active ? enabledItems.findIndex((item) => itemRefs.current.get(item.id) === active) : -1
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusItem(current + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusItem(current <= 0 ? enabledItems.length - 1 : current - 1)
        break
      case 'Home':
        event.preventDefault()
        focusItem(0)
        break
      case 'End':
        event.preventDefault()
        focusItem(Math.max(0, enabledItems.length - 1))
        break
      case 'Escape':
      case 'Tab':
        // Tab does not roam a menu: leave it, and hand focus back to the trigger.
        event.preventDefault()
        close(true)
        break
      default:
        break
    }
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape') {
      if (!isOpen) return
      event.preventDefault()
      close(true)
      return
    }
    // Enter / Space open the menu through the trigger's own native click.
    if (isOpen || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    // Arrow keys are the APG affordance for "open and land me on the first item".
    event.preventDefault()
    setOpen(true)
  }

  function renderItem(item: DropdownMenuItem) {
    const classes = cn(
      ITEM_BASE,
      ITEM_SIZE[size],
      ITEM_TONE[item.danger ? 'danger' : 'default'],
      item.disabled && 'is-disabled',
    )
    const ref = (node: HTMLElement | null) => {
      itemRefs.current.set(item.id, node)
    }

    if (item.href) {
      return (
        <Link
          key={item.id}
          ref={ref}
          href={item.href}
          role="menuitem"
          tabIndex={-1}
          aria-disabled={item.disabled ? true : undefined}
          onClick={(event) => {
            if (item.disabled) {
              event.preventDefault()
              return
            }
            setOpen(false)
            item.onSelect?.()
          }}
          onKeyDown={(event) => {
            // Enter activates an `<a>` natively; Space does not, so trigger click
            // to navigate via Link while closing the menu, instead of scrolling.
            if (event.key !== ' ') return
            event.preventDefault()
            if (item.disabled) return
            event.currentTarget.click()
          }}
          className={classes}
        >
          {item.icon}
          {item.label}
        </Link>
      )
    }

    return (
      <button
        key={item.id}
        ref={ref}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-disabled={item.disabled || undefined}
        aria-busy={item.loading || undefined}
        className={classes}
        onClick={() => activate(item)}
      >
        {item.loading ? <Spinner size="sm" /> : item.icon}
        {item.label}
      </button>
    )
  }

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (isOpen ? close(false) : setOpen(true))}
        onKeyDown={onTriggerKeyDown}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={mounted ? panelId : undefined}
        className={cn(
          'inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-pill',
          'transition-colors',
          triggerClassName,
        )}
      >
        {trigger}
      </button>

      {mounted ? (
        <div
          id={panelId}
          role="menu"
          aria-label={menuLabel ?? triggerLabel}
          tabIndex={-1}
          onKeyDown={onPanelKeyDown}
          className={cn(
            'absolute top-full z-dropdown mt-2 flex w-56 flex-col gap-1',
            'rounded-popover bg-surface border border-border p-1.5 shadow-dropdown',
            align === 'end' ? 'right-0' : 'left-0',
            closing ? 'pointer-events-none motion-fade-out' : 'motion-menu',
            menuClassName,
          )}
        >
          {header}
          {overline ? (
            <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground tracking-normal">{overline}</p>
          ) : null}
          {items.map(renderItem)}
        </div>
      ) : null}
    </div>
  )
}
