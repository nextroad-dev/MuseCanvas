import assert from 'node:assert/strict'
import test from 'node:test'
import { assertLocalObjectKey } from './object-key'
import { STORAGE_KEY_INVALID } from './types'

test('accepts plain relative keys', () => {
  for (const key of ['a', 'user-1/run-2/0-abc.png', 'setup-tests/3f2c.txt', 'x/y.z/w.mp4']) {
    assert.equal(assertLocalObjectKey(key), key)
  }
})

test('rejects traversal, absolute, separator, control, drive-like and sidecar keys', () => {
  const hostile = [
    '',
    '/etc/passwd',
    '../x',
    'a/../b',
    'a/./b',
    'a//b',
    './a',
    'a/',
    'a\\b',
    'C:x',
    'a:b',
    'a\u0000b',
    'a\nb',
    'a\u007fb',
    'x.meta.json',
    'a/.. ',
    'a/b.',
    'a/b ',
    'x'.repeat(1025),
  ]
  for (const key of hostile) {
    assert.throws(() => assertLocalObjectKey(key), (error: unknown) => (error as Error).message === STORAGE_KEY_INVALID, JSON.stringify(key))
  }
})

// Shared with apps/worker/src/shared/storage.test.ts. Keep the two literals identical.
const SHARED_ACCEPTED_KEYS = [
  'meta.json',
  'x.meta.json.bak',
  'CONSOLE',
  'con-1.png',
  'auxiliary.png',
  'COM0',
  'COM10',
  'LPT0',
  'nul2/x.png',
  'x/CONTENT.png',
]
const SHARED_REJECTED_KEYS = [
  'x.meta.json',
  'x.META.JSON',
  'a/b.Meta.Json',
  'CON',
  'con.txt',
  'a/NUL',
  'a/nul.png',
  'prn/x.png',
  'Aux/b',
  'COM1',
  'com9.txt',
  'LPT1/x.png',
  'x/lpt9',
  'COM¹.txt',
  'LPT³',
  'NUL .txt',
]

test('shared vectors: sidecar aliases and Windows device names are refused in any letter case', () => {
  for (const key of SHARED_REJECTED_KEYS) {
    assert.throws(() => assertLocalObjectKey(key), (error: unknown) => (error as Error).message === STORAGE_KEY_INVALID, JSON.stringify(key))
  }
  for (const key of SHARED_ACCEPTED_KEYS) {
    assert.equal(assertLocalObjectKey(key), key, JSON.stringify(key))
  }
})

test('accepts keys at the length limit', () => {
  const key = 'x'.repeat(1024)
  assert.equal(assertLocalObjectKey(key), key)
})
