'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { MoonIcon as Moon, SunIcon as Sun } from '@phosphor-icons/react'
import { cn } from '@/shared/lib/cn'
import { ghostIconButtonVariants } from './button-variants'
import { iconSize } from './size'

export type Theme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'muse-theme'

export function getTheme(): Theme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Storage can be unavailable (private mode); the toggle still works for
    // this session because the attribute drives every token.
  }
}

/** The `data-theme` attribute is the single source of truth — the inline script in
 *  the root `<head>` sets it before first paint, and the OS preference can change
 *  under us — so the toggle subscribes to the attribute instead of holding its own
 *  copy of the state. */
function subscribe(onStoreChange: () => void) {
  const observer = new MutationObserver(onStoreChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

const getServerTheme = (): Theme => 'light'

/**
 * Sun/Moon control for the `[data-theme]` switch in `globals.css`.
 *
 * Both glyphs ship in the markup and CSS picks one through the `dark:` variant, so
 * the icon shown on the very first paint is already the right one: no wrong-icon
 * flash, and the server HTML matches the client's hydration output. `aria-pressed`
 * and `aria-label` carry the current state and the action, and the hit target is a
 * 40px control (`--control-md`).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, getTheme, getServerTheme)
  const isDark = theme === 'dark'

  const toggle = useCallback(() => {
    applyTheme(getTheme() === 'dark' ? 'light' : 'dark')
  }, [])

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
      aria-pressed={isDark}
      className={cn(ghostIconButtonVariants({ size: 'md' }), className)}
    >
      <Sun weight="bold" aria-hidden="true" className={`block ${iconSize.md} dark:hidden`} />
      <Moon weight="bold" aria-hidden="true" className={`hidden ${iconSize.md} dark:block`} />
    </button>
  )
}
