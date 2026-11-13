import test from 'node:test'
import assert from 'node:assert/strict'
import { nextEnabledIndex, thumbGeometry } from './segmented-math.ts'

test('thumbGeometry keeps a valid offset and width', () => {
  assert.deepEqual(thumbGeometry(48, 96), { left: 48, width: 96 })
})

test('thumbGeometry clamps detach/hidden-tab measurements to zero', () => {
  assert.deepEqual(thumbGeometry(Number.NaN, Number.POSITIVE_INFINITY), { left: 0, width: 0 })
  assert.deepEqual(thumbGeometry(-12, -4), { left: 0, width: 0 })
})

test('nextEnabledIndex wraps in both directions', () => {
  assert.equal(nextEnabledIndex([true, true, true], 2, 1), 0)
  assert.equal(nextEnabledIndex([true, true, true], 0, -1), 2)
  assert.equal(nextEnabledIndex([true, true, true], 0, 1), 1)
})

test('nextEnabledIndex skips disabled items', () => {
  assert.equal(nextEnabledIndex([true, false, true], 0, 1), 2)
  assert.equal(nextEnabledIndex([true, false, true], 2, 1), 0)
  assert.equal(nextEnabledIndex([false, true, false], 0, 1), 1)
})

test('nextEnabledIndex reports -1 for an empty group and keeps the index otherwise', () => {
  assert.equal(nextEnabledIndex([], 0, 1), -1)
  assert.equal(nextEnabledIndex([false, false], 0, 1), 0)
})
