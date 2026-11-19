'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { AnimationEvent as ReactAnimationEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react'
import { modalStack } from '@/shared/lib/modal-stack'
import type { ModalDirection } from '@/shared/lib/modal-stack'
import { exitBackstopMs, exitDurationMs } from '@/shared/lib/motion'

/** 面板里可以用 Tab 落到的元素，按 DOM 顺序。 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/** globals.css 里的关键帧名：靠名字识别「入场是否结束 / 退出是否结束」。 */
const ENTER_ANIMATIONS = new Set([
  'mc-fade-in',
  'mc-reveal-up',
  'mc-pop-in',
  'mc-slide-in-down',
  'mc-slide-in-right',
  'mc-slide-in-left',
  'mc-panel-in',
])
const EXIT_ANIMATIONS = new Set([
  'mc-fade-out',
  'mc-scale-out',
  'mc-slide-out-down',
  'mc-slide-out-right',
  'mc-slide-out-left',
  'mc-panel-out',
])

export type DialogPhase = 'enter' | 'idle' | 'exit'

/**
 * 打开时焦点落在哪：`close`（默认，最稳妥）/ `first-input`（内容优先的弹层）/
 * `none`（点开图片查看器这类不该抢焦点的场景）。
 */
export type DialogInitialFocus = 'close' | 'first-input' | 'none'

export interface UseDialogOptions {
  /** 目标可见性；置 false 先播退出动画再卸载。 */
  open: boolean
  onClose: () => void
  /** 退出兜底时长（ms）；缺省用 `--motion-exit` + 余量。 */
  exitMs?: number
  initialFocus?: DialogInitialFocus
  /** 可选：← / → 翻页（灯箱）。 */
  onNavigate?: (direction: ModalDirection) => void
}

export interface DialogOverlayProps {
  ref: RefObject<HTMLDivElement | null>
  onClick: (event: ReactMouseEvent<HTMLDivElement>) => void
  onAnimationEnd: (event: ReactAnimationEvent<HTMLDivElement>) => void
}

export interface DialogPanelProps {
  ref: RefObject<HTMLDivElement | null>
  role: 'dialog'
  'aria-modal': true
  'aria-labelledby': string
  tabIndex: -1
  onAnimationEnd: (event: ReactAnimationEvent<HTMLDivElement>) => void
}

export interface UseDialogResult {
  /** 挂载 `createPortal` 的门闩，同时是 SSR 守卫。 */
  mounted: boolean
  phase: DialogPhase
  /** 退出阶段（`phase === 'exit'`）的便捷布尔，供 ui-kit 消费。 */
  closing: boolean
  /** 面板标题的 id，用于 `aria-labelledby`。 */
  labelId: string
  dialogRef: RefObject<HTMLDivElement | null>
  /** 指向关闭按钮；默认初始焦点落在它上面，`first-input` 时跳过它。 */
  closeButtonRef: RefObject<HTMLButtonElement | null>
  portalTarget: HTMLElement | null
  /** 铺在最外层（遮罩层）的属性：点击空白关闭 + 承接动画结束事件。 */
  overlayProps: DialogOverlayProps
  /** 旧调用点兼容别名，内容等同 `overlayProps`。 */
  rootProps: DialogOverlayProps
  /** 铺在面板上的属性：角色、模态语义与焦点边界。 */
  dialogProps: DialogPanelProps
}

function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0
}

/** 面板里第一个可实际操作的控件（跳过关闭按钮与不可见节点）。 */
function firstInteractable(scope: HTMLElement, skip: HTMLElement | null): HTMLElement | null {
  for (const node of Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))) {
    if (node === skip || node.tabIndex < 0 || !isVisible(node)) continue
    return node
  }
  return null
}

/**
 * 通用模态 hook：生命周期（enter → idle → exit → 卸载）、焦点陷阱、Esc、焦点恢复、
 * 背景滚动锁定与 inert、退出计时（animationend + 计时器双保险）。
 *
 * 生命周期刻意由「动画事件 + 计时器」共同驱动：animationend 在缺少动画、
 * 标签页后台、祖先 display:none 时不会触发，只靠它会把退出中的弹窗永久留在
 * 屏幕上；只靠计时器又会在动画被 reduced-motion 归零时白等。两者谁先到谁卸载。
 *
 * 嵌套：dropdown 在 dialog 内时，dropdown 自己 `preventDefault()` 的 Escape
 * 会被 modal-stack 跳过（见 lib/modal-stack），因此 Esc 只关一层；Tab 循环
 * 只在 `modalStack.isTop` 为真时生效，弹窗叠弹窗不会互相抢焦点。
 */
export function useDialog({
  open,
  onClose,
  exitMs,
  initialFocus = 'close',
  onNavigate,
}: UseDialogOptions): UseDialogResult {
  const labelId = useId()
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [mounted, setMounted] = useState(false)
  const [phase, setPhase] = useState<DialogPhase>('enter')

  // 回调放 ref：父组件每次重渲染不必重新注册模态栈。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate

  // open → 阶段机。挂载只发生在 effect 里：createPortal 在 SSR 没有目标，
  // 且首屏服务端与客户端必须输出一致的 null。
  useEffect(() => {
    if (open) {
      if (!mounted) {
        setMounted(true)
        setPhase('enter')
      } else if (phase === 'exit') {
        // 退出中途重新打开：取消退出而不是叠一层陈旧的关闭。
        setPhase('enter')
      }
      return
    }
    if (mounted && phase !== 'exit') setPhase('exit')
  }, [open, mounted, phase])

  // 退出兜底：animationend 正常时先到并立即卸载，事件丢失时由计时器收尾。
  useEffect(() => {
    if (!mounted || phase !== 'exit') return
    const timer = window.setTimeout(() => setMounted(false), exitBackstopMs(exitMs ?? exitDurationMs()))
    return () => window.clearTimeout(timer)
  }, [mounted, phase, exitMs])

  const handleAnimationEnd = (event: ReactAnimationEvent<HTMLDivElement>) => {
    // 只认根节点、面板本身以及根的直接子节点（遮罩），子内容的动画不驱动卸载。
    const root = overlayRef.current
    const panel = dialogRef.current
    const target = event.target as HTMLElement
    if (target !== root && target !== panel && target.parentElement !== root) return

    if (phase === 'enter' && ENTER_ANIMATIONS.has(event.animationName)) {
      setPhase('idle')
      return
    }
    if (phase === 'exit' && EXIT_ANIMATIONS.has(event.animationName)) setMounted(false)
  }

  // 初始焦点：rAF 等面板真正进 DOM 后再落点，preventScroll 避免整页滚动。
  useEffect(() => {
    if (!mounted) return
    const frame = requestAnimationFrame(() => {
      if (initialFocus === 'none') return
      const panel = dialogRef.current
      if (!panel) return
      const target =
        initialFocus === 'first-input' ? firstInteractable(panel, closeButtonRef.current) : null
      const landing = target ?? closeButtonRef.current ?? panel
      if (landing && document.contains(landing)) landing.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [mounted, initialFocus])

  // 模态栈注册：滚动锁定、背景 inert、Esc、↑层箭头与注销时的焦点恢复。
  useEffect(() => {
    if (!mounted) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return modalStack.push({
      id: labelId,
      getRoot: () => overlayRef.current,
      getDialog: () => dialogRef.current,
      onClose: () => onCloseRef.current(),
      onNavigate: onNavigate ? (direction) => onNavigateRef.current?.(direction) : undefined,
      restoreFocusElement: previouslyFocused,
    })
  }, [mounted, labelId, onNavigate])

  // Tab / Shift+Tab 焦点陷阱：只由最上层模态接管，循环于面板内可聚焦元素之间。
  useEffect(() => {
    if (!mounted || phase === 'exit') return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing) return
      if (!modalStack.isTop(labelId)) return

      const scope = dialogRef.current ?? overlayRef.current
      if (!scope) return
      const focusables = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible)

      if (focusables.length === 0) {
        event.preventDefault()
        dialogRef.current?.focus({ preventScroll: true })
        return
      }

      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (!first || !last) return
      const active = document.activeElement

      if (!scope.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mounted, phase, labelId])

  // 点击遮罩空白处关闭：只有事件目标就是最外层本身才关，点面板内部不关。
  const handleOverlayClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onCloseRef.current()
  }

  const overlayProps: DialogOverlayProps = {
    ref: overlayRef,
    onClick: handleOverlayClick,
    onAnimationEnd: handleAnimationEnd,
  }

  return {
    mounted,
    phase,
    closing: phase === 'exit',
    labelId,
    dialogRef,
    closeButtonRef,
    portalTarget: mounted && typeof document !== 'undefined' ? document.body : null,
    overlayProps,
    rootProps: overlayProps,
    dialogProps: {
      ref: dialogRef,
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': labelId,
      tabIndex: -1,
      onAnimationEnd: handleAnimationEnd,
    },
  }
}
