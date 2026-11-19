'use client'

import { MonitorIcon, MoonIcon, SunIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

import { cn } from '@/shared/lib/cn'
import { prefersReducedMotion } from '@/shared/lib/motion'
import { IconButton } from './button'
import { iconSize } from './size'

/** 三态主题：浅色 → 深色 → 跟随系统（循环）。 */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 与 `shared/components/theme-boot-script.tsx` 共用同一持久化键。 */
const STORAGE_KEY = 'musecanvas-theme'

const MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

const MODE_LABEL: Record<ThemeMode, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
}

const MODE_ICON = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
} as const

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* 隐私模式或禁用 localStorage 时按 system 处理 */
  }
  return 'system'
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

function applyMode(mode: ThemeMode) {
  const resolved: ThemeMode = mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
}

/**
 * 主题切换按钮：36×36（`size="icon"` = `--control-md`）、`rounded-control`、ghost 反馈。
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [mode, setMode] = useState<ThemeMode>('system')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const stored = readStoredMode()
    setMode(stored)
    setMounted(true)
    applyMode(stored)
  }, [])

  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined') return
    const query = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!query) return
    const onChange = () => applyMode('system')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [mode])

  const cycle = () => {
    const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length]
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 存储失败只影响下次进入 */
    }
    const commit = () => {
      setMode(next)
      applyMode(next)
    }
    const doc =
      typeof document !== 'undefined'
        ? (document as Document & { startViewTransition?: (cb: () => void) => unknown })
        : null
    if (doc && typeof doc.startViewTransition === 'function' && !prefersReducedMotion()) {
      doc.startViewTransition(() => {
        flushSync(commit)
      })
      return
    }
    commit()
  }

  const Icon = MODE_ICON[mode]
  const title = mounted ? `切换主题（当前：${MODE_LABEL[mode]}）` : '切换主题'

  return (
    <IconButton
      aria-label="切换主题"
      title={title}
      variant="ghost"
      size="icon"
      icon={<Icon key={mode} weight="regular" aria-hidden="true" className={cn(iconSize.sm, 'motion-icon-swap')} />}
      onClick={cycle}
      className={cn('text-muted-foreground hover:text-foreground', className)}
    />
  )
}
