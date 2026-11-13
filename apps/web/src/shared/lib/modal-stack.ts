/**
 * 全局模态栈：管注册/注销、背景 inert、滚动锁定与「Esc 只关最上层」。
 *
 * 保证：
 * 1. 嵌套模态中只有最上层响应 Esc（更内层的 dropdown 先 preventDefault 时不再关闭 dialog）。
 * 2. 背景 inert 按层快照与恢复，嵌套模态弹出/收起不会把下层对话也永久禁用。
 * 3. 滚动锁定引用计数：第一个模态上锁，最后一个收起时还原 body 的 overflow/padding。
 * 4. 注销时把焦点还给打开该层模态的元素；焦点陷阱（Tab）由 useDialog 负责。
 */

export type ModalDirection = 'previous' | 'next'

const MEDIA_OR_EDITABLE = 'input, textarea, select, [contenteditable], video, audio'
const INERT_EXEMPT_ATTRIBUTE = 'data-inert-exempt'

export interface ModalRegistration {
  id: string
  /** 模态最外层节点（portal 的根，焦点陷阱与 inert 以它为边界）。 */
  getRoot: () => HTMLElement | null
  getDialog: () => HTMLElement | null
  onClose: () => void
  /** 可选：← / → 翻页（灯箱）。 */
  onNavigate?: ((direction: ModalDirection) => void) | undefined
  /** 打开前拥有焦点的元素，注销时恢复。 */
  restoreFocusElement?: HTMLElement | null
}

interface StackEntry extends ModalRegistration {
  inertState: Map<HTMLElement, boolean>
}

class ModalStack {
  private stack: StackEntry[] = []
  private bodyOverflow = ''
  private bodyPaddingRight = ''
  private listening = false

  /** 注册一层模态，返回注销函数。 */
  push(registration: ModalRegistration): () => void {
    if (typeof window === 'undefined') return () => {}

    if (this.stack.length === 0) this.lockScroll()
    this.attachListener()

    const entry: StackEntry = { ...registration, inertState: new Map() }
    this.applyInert(entry)
    this.stack.push(entry)

    return () => this.pop(entry.id)
  }

  /** 注销指定模态；不在栈内时为空操作。 */
  pop(id: string): void {
    if (typeof window === 'undefined') return
    const index = this.stack.findIndex((entry) => entry.id === id)
    if (index === -1) return

    const [removed] = this.stack.splice(index, 1)
    if (removed) {
      for (const [element, wasInert] of removed.inertState) {
        if (document.contains(element)) element.inert = wasInert
      }
      const restore = removed.restoreFocusElement
      if (restore && document.contains(restore) && !restore.inert) {
        restore.focus({ preventScroll: true })
      }
    }

    if (this.stack.length === 0) {
      this.unlockScroll()
      this.detachListener()
    }
  }

  top(): StackEntry | null {
    return this.stack.at(-1) ?? null
  }

  isTop(id: string): boolean {
    return this.stack.at(-1)?.id === id
  }

  /** 把最上层之外的 body 直接子节点设为 inert，并记录旧值。 */
  private applyInert(entry: StackEntry): void {
    const root = entry.getRoot()
    if (!root) return
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement)) continue
      if (child === root || child.contains(root)) continue
      if (child.hasAttribute(INERT_EXEMPT_ATTRIBUTE)) continue
      entry.inertState.set(child, child.inert)
      child.inert = true
    }
  }

  private lockScroll(): void {
    const { body } = document
    this.bodyOverflow = body.style.overflow
    this.bodyPaddingRight = body.style.paddingRight
    // 滚动条消失会让页面横向跳动，用等宽 padding 补偿。
    const gutter = window.innerWidth - document.documentElement.clientWidth
    body.style.overflow = 'hidden'
    if (gutter > 0) body.style.paddingRight = `${gutter}px`
  }

  private unlockScroll(): void {
    const { body } = document
    body.style.overflow = this.bodyOverflow
    body.style.paddingRight = this.bodyPaddingRight
  }

  private attachListener(): void {
    if (this.listening || typeof window === 'undefined') return
    window.addEventListener('keydown', this.handleKeyDown)
    this.listening = true
  }

  private detachListener(): void {
    if (!this.listening || typeof window === 'undefined') return
    window.removeEventListener('keydown', this.handleKeyDown)
    this.listening = false
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    const top = this.stack.at(-1)
    if (!top) return
    // 内层控件（dropdown 等）已消费的按键不再上抛，避免一次 Esc 关两层。
    if (event.defaultPrevented || event.isComposing) return

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      top.onClose()
      return
    }

    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && top.onNavigate) {
      const target = event.target
      if (target instanceof Element && target.matches(MEDIA_OR_EDITABLE)) return
      event.preventDefault()
      event.stopPropagation()
      top.onNavigate(event.key === 'ArrowLeft' ? 'previous' : 'next')
    }
  }
}

export const modalStack = new ModalStack()
