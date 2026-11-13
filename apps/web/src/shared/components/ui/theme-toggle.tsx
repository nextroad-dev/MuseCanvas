'use client'

import { Monitor, Moon, Sun } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'

import { cn } from '@/shared/lib/cn'
import { IconButton } from './button'

/** 三态主题：浅色 → 深色 → 跟随系统（循环）。 */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 与 `shared/components/theme-boot-script.tsx` 的内联脚本共用同一个键。 */
const STORAGE_KEY = 'musecanvas-theme'

const MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

const MODE_LABEL: Record<ThemeMode, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
}

const MODE_ICON = {
  light: Sun,
  dark: Moon,
  system: Monitor,
} as const

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* localStorage 被禁用（隐私模式 / 沙箱 iframe）时按 system 处理 */
  }
  return 'system'
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/**
 * 把主题模式落到 `<html>`：`dark` class 驱动 CSS token，`data-theme` 供 QA/e2e
 * 读取，`color-scheme` 让滚动条等原生控件同帧切换。规则与首帧启动脚本一致。
 */
function applyMode(mode: ThemeMode) {
  const resolved: ThemeMode = mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
}

/**
 * 主题切换按钮：36×36（`--control-compact`）、`rounded-control`、ghost 反馈。
 *
 * hydration 策略：首帧一律渲染 `system` 图标（与启动脚本的默认值一致，SSR 与
 * 首次 CSR 输出相同），挂载后再读取 localStorage 并把图标换成真实状态；`system`
 * 模式下监听系统外观变化，保持与操作系统同步。
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
    setMode(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 存储失败只影响下次进入，当前会话仍然即时生效 */
    }
    applyMode(next)
  }

  const Icon = MODE_ICON[mode]
  const title = mounted ? `切换主题（当前：${MODE_LABEL[mode]}）` : '切换主题'

  return (
    <IconButton
      aria-label="切换主题"
      title={title}
      variant="ghost"
      icon={<Icon size={18} aria-hidden="true" />}
      onClick={cycle}
      className={cn('size-[var(--control-compact)]', className)}
    />
  )
}
