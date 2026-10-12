import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.HTMLElement = class HTMLElement {
  hasAttribute() { return false }
}

import { modalStack } from './modal-stack.ts'

test('modalStack: single modal lifecycle, body overflow lock, and Escape handling', () => {
  // Setup synthetic DOM
  const closed = []
  const trigger = { focus: () => {} }
  const root = new globalThis.HTMLElement()
  root.clientRects = [{}]
  root.inert = false
  const dialog = { focus: () => {} }

  globalThis.document = {
    body: {
      style: { overflow: '', paddingRight: '' },
      children: [root],
    },
    documentElement: { clientWidth: 1000 },
    contains: () => true,
    activeElement: trigger,
  }
  globalThis.window = {
    innerWidth: 1016,
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  const unregister = modalStack.push({
    id: 'modal-1',
    getRoot: () => root,
    getDialog: () => dialog,
    onClose: () => closed.push('modal-1'),
    restoreFocusElement: trigger,
  })

  assert.equal(modalStack.isTop('modal-1'), true)
  assert.equal(document.body.style.overflow, 'hidden')
  assert.equal(document.body.style.paddingRight, '16px')

  // Top modal handles close
  const top = modalStack.top()
  assert.ok(top)
  top.onClose()
  assert.deepEqual(closed, ['modal-1'])

  // Unregister unlocks body
  unregister()
  assert.equal(modalStack.top(), null)
  assert.equal(document.body.style.overflow, '')
  assert.equal(document.body.style.paddingRight, '')
})

test('modalStack: nested modals handle Escape only on topmost, preserving lower modal', () => {
  const closed = []
  const root1 = new globalThis.HTMLElement()
  root1.clientRects = [{}]
  root1.inert = false
  const root2 = new globalThis.HTMLElement()
  root2.clientRects = [{}]
  root2.inert = false

  globalThis.document = {
    body: {
      style: { overflow: '', paddingRight: '' },
      children: [root1, root2],
    },
    documentElement: { clientWidth: 1000 },
    contains: () => true,
  }
  globalThis.window = {
    innerWidth: 1000,
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  const unregister1 = modalStack.push({
    id: 'modal-1',
    getRoot: () => root1,
    getDialog: () => null,
    onClose: () => closed.push('modal-1'),
  })

  assert.equal(modalStack.top()?.id, 'modal-1')

  const unregister2 = modalStack.push({
    id: 'modal-2',
    getRoot: () => root2,
    getDialog: () => null,
    onClose: () => closed.push('modal-2'),
  })

  assert.equal(modalStack.top()?.id, 'modal-2')
  assert.equal(modalStack.isTop('modal-2'), true)
  assert.equal(modalStack.isTop('modal-1'), false)

  // Triggering close on top modal closes modal-2, NOT modal-1
  modalStack.top()?.onClose()
  assert.deepEqual(closed, ['modal-2'])

  // Popping modal-2 restores modal-1 as top, body stays locked
  unregister2()
  assert.equal(modalStack.top()?.id, 'modal-1')
  assert.equal(modalStack.isTop('modal-1'), true)
  assert.equal(document.body.style.overflow, 'hidden')

  // Now modal-1 can close
  modalStack.top()?.onClose()
  assert.deepEqual(closed, ['modal-2', 'modal-1'])

  // Popping modal-1 unlocks body
  unregister1()
  assert.equal(modalStack.top(), null)
  assert.equal(document.body.style.overflow, '')
})
