'use client'

import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { GenerateModeTab } from '@/shared/types'

export interface GenerateModeTabItem {
  id: GenerateModeTab
  label: string
  icon: LucideIcon
  /** No model of that kind is configured. Announced through `aria-disabled`
   *  instead of the `disabled` attribute so the tab stays focusable and
   *  selectable: that is how the user reaches its guidance panel. */
  disabled?: boolean
}

export interface GenerateModeTabsProps {
  tabs: GenerateModeTabItem[]
  value: GenerateModeTab
  onChange: (tab: GenerateModeTab) => void
}

/**
 * Underline tab bar for the creation console (same class strings as the admin
 * user/invitation tabs). Selection follows focus, so it stays inside the
 * `tabIndex={0}` active tab and never leaves the tablist.
 */
export function GenerateModeTabs({ tabs, value, onChange }: GenerateModeTabsProps) {
  const listRef = useRef<HTMLDivElement>(null)

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (tabs.length === 0) return
    const current = tabs.findIndex((tab) => tab.id === value)
    if (current < 0) return
    let next = -1
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    const target = tabs[next]
    onChange(target.id)
    // Every tab is rendered up front, so the node already exists: moving the
    // active state and focusing it in the same gesture keeps the roving tab
    // index honest without waiting for a re-render.
    listRef.current?.querySelector<HTMLButtonElement>(`#gen-tab-${target.id}`)?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="创作类型"
      onKeyDown={handleKeyDown}
      className="flex border-b border-border"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === value
        const Icon = tab.icon
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`gen-tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`gen-panel-${tab.id}`}
            aria-disabled={tab.disabled === true || undefined}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              isActive
                ? 'border-accent text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon aria-hidden="true" className="h-4 w-4" />
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
