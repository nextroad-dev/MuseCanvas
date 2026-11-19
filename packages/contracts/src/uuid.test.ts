import test from 'node:test'
import assert from 'node:assert/strict'
import { isCanvasUuid, isUuid } from './index'

const id = (n: number) => `12345678-abcd-4234-8234-${n.toString(16).padStart(12, '0')}`

test('isUuid accepts canonical lowercase and uppercase UUIDs', () => {
  assert.equal(isUuid(id(1)), true)
  assert.equal(isUuid(id(2).toUpperCase()), true)
})

test('isUuid rejects non-strings and malformed shapes', () => {
  for (const value of ['', 1, null, undefined, {}, 'not-a-uuid', `${id(3)}x`, id(4).slice(0, 35)]) {
    assert.equal(isUuid(value), false, `expected reject: ${String(value)}`)
  }
})

test('isCanvasUuid stays an alias of isUuid', () => {
  assert.equal(isCanvasUuid(id(5)), true)
  assert.equal(isCanvasUuid('12345678-abcd-4234-8234-00000000000g'), false)
})
