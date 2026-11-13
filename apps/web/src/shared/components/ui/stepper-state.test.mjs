import test from 'node:test'
import assert from 'node:assert/strict'
import { stepperState } from './stepper-state.ts'

test('a sequential wizard marks earlier steps complete and the current one current', () => {
  assert.deepEqual(stepperState({ id: 'a' }, 0, 1), { completed: true, current: false, navigable: true })
  assert.deepEqual(stepperState({ id: 'b' }, 1, 1), { completed: false, current: true, navigable: false })
  assert.deepEqual(stepperState({ id: 'c' }, 2, 1), { completed: false, current: false, navigable: false })
})

test('explicit completion outranks position (a skipped-but-done step)', () => {
  assert.equal(stepperState({ id: 'a', completed: true }, 2, 0).completed, true)
  assert.equal(stepperState({ id: 'a', completed: false }, 0, 3).completed, false)
})

test('a visit makes a step navigable without claiming completion', () => {
  const state = stepperState({ id: 'a', visited: true }, 2, 0)
  assert.equal(state.completed, false)
  assert.equal(state.navigable, true)
})

test('a future step is never navigable by default', () => {
  assert.equal(stepperState({ id: 'future' }, 4, 1).navigable, false)
})
