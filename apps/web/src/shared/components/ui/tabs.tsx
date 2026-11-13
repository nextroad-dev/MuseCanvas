'use client'

import { useId, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { colourTransition } from './interaction'
import { controlMinHeight, iconSlot, touchTarget } from './size'

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
  /** Controlled selection — pair with local state or a store. */
  value: string
  onChange: (id: string) => void
  /** `segment` (default) is the board-08 partition switcher; `underline` is the denser inline nav. */
  variant?: 'segment' | 'underline'
  /**
   * `automatic`（默认）方向键即选中；面板打开才发请求时用 `manual`，避免遍历触发
   * 一连串请求。
   */
  activation?: 'automatic' | 'manual'
  /** Keep only the active panel mounted. */
  lazy?: boolean
  className?: string
  listClassName?: string
  /** Accessible name for the tab list, e.g. `资源分区`. */
  'aria-label'?: string
}

const TAB_BASE = [
  'relative inline-flex shrink-0 select-none items-center gap-2 whitespace-nowrap',
  'rounded-control px-3 text-sm font-medium',
  `${iconSlot.sm} [&>svg]:shrink-0`,
  colourTransition,
].join(' ')

/**
 * 可访问 Tabs，完整 APG 语义：`tablist` / `tab` / `tabpanel`、`aria-selected`、
 * `aria-controls` ↔ `aria-labelledby` 双向、单一 Tab 停靠点、方向键/Home/End 漫游。
 * 视觉沿用设计系统的分段样式：弱色轨道 + 白色抬起选中项；滑动指示块属于
 * `SegmentedControl`，这里刻意不做。
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
  const tabRefs = useRef(new Map<string, HTMLButtonElement | null>())

  const tabId = (id: string) => `${uid}-tab-${id}`
  const panelId = (id: string) => `${uid}-panel-${id}`

  const enabled = tabs.filter((tab) => !tab.disabled)
  const activeIndex = Math.max(0, enabled.findIndex((tab) => tab.id === value))
  const rovingId = enabled[activeIndex]?.id ?? value

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
        role="tablist"
        aria-label={ariaLabel}
        className={cn(
          'relative flex min-w-0 max-w-full items-center overflow-x-auto',
          variant === 'segment' ? 'gap-1 self-start rounded-control bg-tonal p-1' : 'gap-1 border-b border-border',
          listClassName,
        )}
      >
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
                controlMinHeight.md,
                touchTarget,
                variant === 'segment' ? 'px-3.5' : 'rounded-none px-3',
                variant === 'segment'
                  ? selected
                    ? 'bg-surface text-foreground shadow-soft'
                    : 'text-muted-foreground not-disabled:hover:text-foreground'
                  : selected
                    ? 'border-b-2 border-primary text-foreground'
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
