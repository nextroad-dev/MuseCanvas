'use client'

import { useEffect, useState } from 'react'
import type { AnimationEvent as ReactAnimationEvent } from 'react'
import { exitBackstopMs, exitDurationMs } from '@/shared/lib/motion'

export type PresencePhase = 'enter' | 'idle' | 'exit'

export interface UseAnimatedPresenceOptions {
  /** 可选自定义退出兜底时长（ms）；缺省读取 `--motion-exit` + 余量。 */
  exitMs?: number
}

export interface UseAnimatedPresenceResult {
  /** 是否保留 DOM 挂载（退场期间仍为 true，直到 animationend 或兜底计时器到期）。 */
  mounted: boolean
  /** 当前所处阶段。 */
  phase: PresencePhase
  /** `phase === 'exit'` 的便捷布尔。 */
  closing: boolean
  /** 绑定在承担退场动画的容器元素上，用于捕捉动画结束事件。 */
  onAnimationEnd: (event: ReactAnimationEvent<HTMLElement>) => void
}

const EXIT_ANIMATIONS = new Set([
  'mc-fade-out',
  'mc-scale-out',
  'mc-slide-out-down',
  'mc-slide-out-right',
  'mc-slide-out-left',
  'mc-panel-out',
])

const ENTER_ANIMATIONS = new Set([
  'mc-fade-in',
  'mc-reveal-up',
  'mc-pop-in',
  'mc-slide-in-down',
  'mc-slide-in-right',
  'mc-slide-in-left',
  'mc-panel-in',
])

/**
 * 轻量非模态浮层 / 抽屉退场存在性 hook。
 *
 * 与 `useDialog` 一致采用「animationend + 计时器双保险」卸载机制：
 * - 不占用模态栈、不锁滚动、不做焦点陷阱（适用于可与画布共存的检查器、侧栏抽屉等）；
 * - 退场中途重新打开会立刻取消退出回到 `enter`，保证可中断连续性；
 * - reduced-motion 下 `animationend` 会在 0.01ms 立即触发卸载，无需空等计时器。
 */
export function useAnimatedPresence(
  open: boolean,
  options?: UseAnimatedPresenceOptions,
): UseAnimatedPresenceResult {
  const [mounted, setMounted] = useState(open)
  const [phase, setPhase] = useState<PresencePhase>(open ? 'enter' : 'exit')
  const exitMs = options?.exitMs

  useEffect(() => {
    if (open) {
      setMounted(true)
      setPhase((prev) => (prev === 'idle' ? 'idle' : 'enter'))
      return
    }
    setPhase((prev) => (mounted && prev !== 'exit' ? 'exit' : prev))
  }, [open, mounted])

  useEffect(() => {
    if (!mounted || phase !== 'exit') return
    const timer = window.setTimeout(
      () => setMounted(false),
      exitBackstopMs(exitMs ?? exitDurationMs()),
    )
    return () => window.clearTimeout(timer)
  }, [mounted, phase, exitMs])

  const onAnimationEnd = (event: ReactAnimationEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return
    if (phase === 'enter' && ENTER_ANIMATIONS.has(event.animationName)) {
      setPhase('idle')
      return
    }
    if (phase === 'exit' && EXIT_ANIMATIONS.has(event.animationName)) {
      setMounted(false)
    }
  }

  return {
    mounted,
    phase,
    closing: phase === 'exit',
    onAnimationEnd,
  }
}
