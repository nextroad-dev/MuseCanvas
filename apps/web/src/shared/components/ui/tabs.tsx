'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { colourTransition } from './interaction'
import { controlMinHeight, iconSlot, touchTarget } from './size'

const useSafeLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

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
  value: string
  onChange: (id: string) => void
  variant?: 'segment' | 'underline'
  activation?: 'automatic' | 'manual'
  lazy?: boolean
  className?: string
  listClassName?: string
  'aria-label'?: string
}

const TAB_BASE = [
  'relative inline-flex shrink-0 select-none items-center gap-2 whitespace-nowrap',
  'rounded-control px-3 text-sm font-medium',
  `${iconSlot.sm} [&>svg]:shrink-0`,
  colourTransition,
].join(' ')

/**
 * 可访问 Tabs（APG 语义）：`tablist` / `tab` / `tabpanel`，支持水平滚动收容与方向键/Home/End 漫游。
 */
export function Tabs({
  tabs,
  value,
  onChange,
  variant = 'segment',
  activation = 'automatic',
  lazy,
  className,
  listClassName,
  'aria-label': ariaLabel,
}: TabsProps) {
  const uid = useId()
  const listRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)

  const tabId = (id: string) => `${uid}-tab-${id}`
  const panelId = (id: string) => `${uid}-panel-${id}`

  const enabled = tabs.filter((tab) => !tab.disabled)
  const activeIndex = Math.max(0, enabled.findIndex((tab) => tab.id === value))
  const rovingId = enabled[activeIndex]?.id ?? value

  const measure = useCallback(() => {
    const node = tabRefs.current.get(value)
    if (
      !node ||
      typeof node.offsetLeft !== 'number' ||
      typeof node.offsetWidth !== 'number' ||
      node.offsetWidth <= 0
    ) {
      setIndicator(null)
      return
    }
    setIndicator({ left: node.offsetLeft, width: node.offsetWidth })
  }, [value])

  useSafeLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(() => measure())
    observer.observe(list)
    for (const node of tabRefs.current.values()) {
      if (node instanceof Element) observer.observe(node)
    }
    return () => observer.disconnect()
  }, [measure, tabs.length])

  function moveFocus(from: number, delta: number) {
    if (enabled.length === 0) return
    const next = (from + delta + enabled.length) % enabled.length
    const target = enabled[next]
    tabRefs.current.get(target.id)?.focus()
    if (activation === 'automatic') onChange(target.id)
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
        if (activation === 'manual' && enabled[index]) {
          event.preventDefault()
          onChange(enabled[index].id)
        }
        break
      default:
        break
    }
  }

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        className={cn(
          'relative flex min-w-0 max-w-full items-center overflow-x-auto',
          variant === 'segment'
            ? 'gap-1 self-start rounded-control border border-border/70 bg-tonal p-1'
            : 'gap-1 border-b border-border',
          listClassName,
        )}
      >
        {indicator ? (
          <span
            aria-hidden="true"
            className={cn(
              'motion-position pointer-events-none absolute left-0',
              variant === 'segment'
                ? 'inset-y-1 rounded-control bg-surface shadow-soft'
                : 'bottom-0 h-0.5 rounded-pill bg-primary',
            )}
            style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
          />
        ) : null}
        {tabs.map((tab) => {
          const selected = tab.id === value
          const enabledIndex = enabled.findIndex((candidate) => candidate.id === tab.id)
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
              tabIndex={tab.id === rovingId ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, enabledIndex < 0 ? 0 : enabledIndex)}
              className={cn(
                TAB_BASE,
                'z-1',
                variant === 'segment' ? controlMinHeight.sm : controlMinHeight.md,
                touchTarget,
                variant === 'segment' ? 'px-3.5 text-ui' : 'rounded-none px-3',
                variant === 'segment'
                  ? selected
                    ? indicator
                      ? 'text-foreground'
                      : 'bg-surface text-foreground shadow-soft'
                    : 'text-muted-foreground not-disabled:hover:text-foreground'
                  : selected
                    ? indicator
                      ? 'border-b-2 border-transparent text-foreground'
                      : 'border-b-2 border-primary text-foreground'
                    : 'border-b-2 border-transparent text-muted-foreground not-disabled:hover:text-foreground',
                tab.disabled && 'is-disabled',
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          )
        })}
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
