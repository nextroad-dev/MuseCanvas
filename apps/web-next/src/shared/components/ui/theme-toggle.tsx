'use client'

import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

export function getTheme(): Theme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem('muse-theme', theme)
  } catch {
    // Storage can be unavailable (private mode); the toggle still works for
    // this session because the attribute drives every token.
  }
}

/**
 * Sun/Moon toggle for the `[data-theme]` switch in `globals.css`. Reads the
 * attribute (set pre-paint by the inline script in the root layout) instead of
 * holding its own source of truth, so OS-preference fallbacks and manual
 * choices always render one consistent state.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light')

  useEffect(() => {
    setTheme(getTheme())
  }, [])

  const toggle = useCallback(() => {
    const next = getTheme() === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    setTheme(next)
  }, [])

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
      aria-pressed={theme === 'dark'}
      className="inline-flex h-10 w-10 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-surface-subtle hover:text-foreground motion-press"
    >
      {theme === 'dark' ? (
        <svg width="18" height="18" viewBox="0 0 256 256" fill="none" aria-hidden="true">
          <circle cx="128" cy="128" r="60" stroke="currentColor" strokeWidth="16" />
          <path d="M128 20v28M128 208v28M20 128h28M208 128h28M51.7 51.7l19.8 19.8M184.5 184.5l19.8 19.8M204.3 51.7l-19.8 19.8M71.5 184.5l-19.8 19.8" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 256 256" fill="none" aria-hidden="true">
          <path d="M216.7 152.6A88 88 0 0 1 103.4 39.3a88 88 0 1 0 113.3 113.3Z" stroke="currentColor" strokeWidth="16" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  )
}
