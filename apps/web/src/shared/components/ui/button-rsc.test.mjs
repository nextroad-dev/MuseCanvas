import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as React from 'react'
import { loadButtonModules } from './button-rsc-test-helper.mjs'

const { Button, ButtonInteraction } = loadButtonModules(React)
const child = (props = {}) => React.createElement('a', { href: '/', ...props }, 'Home')

test('Button stays server-capable and real React Flight accepts static Link children', () => {
  assert.doesNotMatch(readFileSync(new URL('./button.tsx', import.meta.url), 'utf8'), /^['"]use client['"]/)
  assert.match(readFileSync(new URL('./button-interaction.tsx', import.meta.url), 'utf8'), /^['"]use client['"]/)
  const result = execFileSync(process.execPath, ['--conditions=react-server', fileURLToPath(new URL('./button-rsc-fixture.mjs', import.meta.url))], { encoding: 'utf8' })
  assert.match(result, /serialize successfully through React Flight/)
  assert.equal(Button({ asChild: true, children: child() }).props.onClick, undefined)
  const native = Button({ children: 'Submit', type: 'submit' })
  assert.equal(native.type, 'button')
  assert.equal(native.props.type, 'submit')
  assert.equal(native.props.onClick, undefined)
})

test('disabled, aria-disabled and loading controls block mouse/keyboard clicks before either callback', () => {
  for (const state of [{ disabled: true }, { loading: true }, { 'aria-disabled': true }, { 'aria-disabled': 'true' }]) {
    for (const asChild of [false, true]) {
      const callbacks = []
      const outer = Button({ ...state, asChild, onClick: () => callbacks.push('parent'),
        children: asChild ? child({ onClick: () => callbacks.push('child') }) : 'Action' })
      assert.equal(outer.type, ButtonInteraction)
      const element = ButtonInteraction(outer.props)
      for (const detail of [0, 1]) {
        const event = { detail, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
        element.props.onClick(event)
        assert.equal(event.defaultPrevented, true)
      }
      assert.deepEqual(callbacks, [])
      if (asChild || state['aria-disabled']) assert.equal(element.props['aria-disabled'], true)
      if (state.loading) assert.equal(element.props['aria-busy'], true)
      if (!asChild && state.disabled) assert.equal(element.props.disabled, true)
    }
  }
})

test('interactive slots compose child then parent and respect child preventDefault', () => {
  for (const cancel of [false, true]) {
    const callbacks = []
    const outer = Button({ asChild: true, onClick: () => callbacks.push('parent'), children: child({
      onClick(event) { callbacks.push('child'); if (cancel) event.preventDefault() },
    }) })
    const element = ButtonInteraction(outer.props)
    element.props.onClick({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true } })
    assert.deepEqual(callbacks, cancel ? ['child'] : ['child', 'parent'])
    assert.equal(element.props.href, '/')
  }
})

test('slot child aria-disabled and native ref/form semantics survive composition', () => {
  const outer = Button({ asChild: true, children: child({ 'aria-disabled': true }) })
  assert.equal(outer.props.blocked, true)
  const ref = { current: null }
  const native = Button({ ref, name: 'intent', value: 'save', form: 'settings', children: 'Save' })
  assert.equal(native.props.ref, ref)
  assert.equal(native.props.name, 'intent')
  assert.equal(native.props.value, 'save')
  assert.equal(native.props.form, 'settings')
})
