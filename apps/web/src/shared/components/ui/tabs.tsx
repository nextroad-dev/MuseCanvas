'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { colourTransition } from './interaction'
import { controlMinHeight, iconSlot } from './size'

export interface TabItem {
  id: string
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
  /** Panel body. Omit to render panels yourself next to `<Tabs>`. */
  content?: ReactNode
}

export interface TabsProps {
  tabs: TabItem[]
  /** Controlled selection — pair with a store or `useState`. */
  value: string
  onValueChange: (id: string) => void
  /** One style per level (components.md Tabs row): never mix the two. */
  variant?: 'underline' | 'segment'
  /**
   * `automatic` (default) selects while arrowing — the APG recommendation when
   * panels are already rendered. Use `manual` when a panel fetches on open, so
   * traversal does not fire five requests: Enter/Space (or click) then selects.
   */
  activation?: 'automatic' | 'manual'
  /** Keep only the active panel mounted. */
  lazy?: boolean
  className?: string
  listClassName?: string
  /** Accessible name for the tab list, e.g. `生成类型`. */
  'aria-label'?: string
}

/**
 * Tabs with the full APG semantics the app's `aria-pressed` filter buttons lack:
 * `tablist`/`tab`/`tabpanel`, `aria-selected`, `aria-controls` ↔
 * `aria-labelledby` both ways, a single roving tab stop, Arrow/Home/End
 * navigation, and an underline that glides via `.motion-position`.
 */
export function Tabs({
  tabs,
  value,
  onValueChange,
  variant = 'underline',
  activation = 'automatic',
  lazy,
  className,
  listClassName,
  'aria-label': ariaLabel,
}: TabsProps) {
  const uid = useId()
  const listRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const [underline, setUnderline] = useState<{ left: number; width: number } | null>(null)

  const tabId = (id: string) => `${uid}-tab-${id}`
  const panelId = (id: string) => `${uid}-panel-${id}`

  const enabled = tabs.filter((tab) => !tab.disabled)
  const activeIndex = Math.max(0, enabled.findIndex((tab) => tab.id === value))
  const rovingId = enabled[activeIndex]?.id ?? value

  const measure = useCallback(() => {
    if (variant !== 'underline') return
    const node = tabRefs.current.get(value)
    if (!node) return
    setUnderline({ left: node.offsetLeft, width: node.offsetWidth })
  }, [variant, value])

  // Re-measure after layout, on tab change and whenever the list resizes — a
  // late web font or a wrapped label moves the underline with it.
  useEffect(() => {
    measure()
    const list = listRef.current
    if (!list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(list)
    return () => observer.disconnect()
  }, [measure])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  function moveFocus(from: number, delta: number) {
    if (enabled.length === 0) return
    const next = (from + delta + enabled.length) % enabled.length
    const target = enabled[next]
    tabRefs.current.get(target.id)?.focus()
    if (activation === 'automatic') onValueChange(target.id)
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault()
        moveFocus(index, 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault()
        moveFocus(index, -1)
        break
      case 'Home':
        event.preventDefault()
        moveFocus(-1, 1)
        break
      case 'End':
        event.preventDefault()
        moveFocus(enabled.length - 2, 1)
        break
      case 'Enter':
      case ' ':
        // Manual activation is the whole point of `activation: 'manual'`.
        if (activation === 'manual' && enabled[index]) {
          event.preventDefault()
          onValueChange(enabled[index].id)
        }
        break
      default:
        break
    }
  }

  const enabledIndexOf = (tabIdValue: string) => enabled.findIndex((tab) => tab.id === tabIdValue)

  return (
    <div className={cn('flex flex-col', className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        className={cn(
          'relative flex items-center',
          variant === 'underline' ? 'gap-1 border-b border-border' : 'gap-1 self-start rounded-control bg-tonal p-1',
          listClassName,
        )}
      >
        {tabs.map((tab) => {
          const selected = tab.id === value
          const focusable = tab.id === rovingId
          const enabledIndex = enabledIndexOf(tab.id)
          return (
            <button
              key={tab.id}
              ref={(node) => {
                tabRefs.current.set(tab.id, node)
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={selected}
              aria-controls={tab.content !== undefined ? panelId(tab.id) : undefined}
              aria-disabled={tab.disabled || undefined}
              disabled={tab.disabled}
              tabIndex={focusable ? 0 : -1}
              onClick={() => onValueChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, enabledIndex < 0 ? 0 : enabledIndex)}
              className={cn(
                'relative inline-flex shrink-0 select-none items-center gap-2 whitespace-nowrap',
                controlMinHeight.md,
                'rounded-control px-3 text-sm font-medium',
                colourTransition,
                `${iconSlot.sm} [&>svg]:shrink-0`,
                variant === 'underline'
                  ? selected
                    ? 'text-foreground'
                    : 'text-muted-foreground not-disabled:hover:text-foreground'
                  : selected
                    ? 'bg-surface text-foreground shadow-soft'
                    : 'text-muted-foreground not-disabled:hover:bg-tonal-hover not-disabled:hover:text-foreground not-disabled:active:bg-tonal-active',
                tab.disabled && 'is-disabled',
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          )
        })}

        {variant === 'underline' && underline ? (
          // The single moving part: `.motion-position` transitions transform+width
          // so the indicator travels instead of teleporting between tabs.
          <span
            aria-hidden="true"
            className="motion-position pointer-events-none absolute -bottom-px h-0.5 rounded-pill bg-primary"
            style={{ transform: `translateX(${underline.left}px)`, width: underline.width }}
          />
        ) : null}
      </div>

      {tabs.map((tab) =>
        tab.content === undefined ? null : (
          <div
            key={tab.id}
            role="tabpanel"
            id={panelId(tab.id)}
            aria-labelledby={tabId(tab.id)}
            tabIndex={0}
            hidden={tab.id !== value}
            className="pt-4"
          >
            {lazy ? (tab.id === value ? tab.content : null) : tab.content}
          </div>
        ),
      )}
    </div>
  )
}
