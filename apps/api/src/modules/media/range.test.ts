import assert from 'node:assert/strict'
import test from 'node:test'
import { parseByteRange } from './range'

test('parses bytes ranges for a 100 byte object', () => {
  const size = 100
  assert.deepEqual(parseByteRange('bytes=0-9', size), { kind: 'partial', start: 0, end: 9 })
  assert.deepEqual(parseByteRange('bytes=90-', size), { kind: 'partial', start: 90, end: 99 })
  assert.deepEqual(parseByteRange('bytes=-10', size), { kind: 'partial', start: 90, end: 99 })
  assert.deepEqual(parseByteRange('bytes=-500', size), { kind: 'partial', start: 0, end: 99 })
  assert.deepEqual(parseByteRange('bytes=0-999', size), { kind: 'partial', start: 0, end: 99 })
  assert.deepEqual(parseByteRange('BYTES= 5-6 ', size), { kind: 'partial', start: 5, end: 6 })
})

test('serves the whole object when no range is requested or the range is ignorable', () => {
  assert.deepEqual(parseByteRange(null, 100), { kind: 'full' })
  assert.deepEqual(parseByteRange('', 100), { kind: 'full' })
  assert.deepEqual(parseByteRange('items=0-1', 100), { kind: 'full' })
  assert.deepEqual(parseByteRange('bytes=0-1,5-6', 100), { kind: 'full' })
})

test('malformed or unsatisfiable ranges are 416', () => {
  for (const header of ['bytes=10-5', 'bytes=100-', 'bytes=abc', 'bytes=-', 'bytes=-0', 'bytes=5', 'bytes=--3', 'bytes=1-2-3']) {
    assert.deepEqual(parseByteRange(header, 100), { kind: 'unsatisfiable' }, header)
  }
  assert.deepEqual(parseByteRange('bytes=0-', 0), { kind: 'unsatisfiable' })
  assert.deepEqual(parseByteRange('bytes=-5', 0), { kind: 'unsatisfiable' })
})

test('oversized numeric bounds are rejected rather than coerced', () => {
  assert.deepEqual(parseByteRange('bytes=0-99999999999999999999', 100), { kind: 'unsatisfiable' })
})
