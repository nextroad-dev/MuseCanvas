import assert from 'node:assert/strict'
import test from 'node:test'

import { validateStorageInput, type InputError, type ValidStorageInput } from './validation'

function accepted(input: Record<string, unknown>): ValidStorageInput {
  const result = validateStorageInput(input)
  if ('code' in result) assert.fail(`expected acceptance, got ${result.code}: ${result.message}`)
  return result
}

function rejected(input: Record<string, unknown>): InputError {
  const result = validateStorageInput(input)
  if (!('code' in result)) assert.fail('expected rejection, got a valid storage input')
  assert.equal(result.code, 'INVALID_INPUT')
  return result
}

test('a payload without driver leaves it undefined, meaning keep the stored driver', () => {
  const valid = accepted({ bucket: 'assets', accessKeyId: 'AKIA1', secretAccessKey: 'secret' })
  assert.equal(valid.driver, undefined)
  assert.equal(valid.localRoot, undefined)
})

test('driver local accepts an absolute Windows or POSIX root and trims surrounding whitespace', () => {
  assert.equal(accepted({ driver: 'local', localRoot: 'D:\\musecanvas\\media' }).localRoot, 'D:\\musecanvas\\media')
  assert.equal(accepted({ driver: 'local', localRoot: '/var/lib/musecanvas/media' }).localRoot, '/var/lib/musecanvas/media')
  assert.equal(accepted({ driver: 'local', localRoot: '  /srv/media  ' }).localRoot, '/srv/media')
})

test('driver local requires a root: missing, null, empty and blank are rejected', () => {
  for (const input of [{ driver: 'local' }, { driver: 'local', localRoot: null }, { driver: 'local', localRoot: '' }, { driver: 'local', localRoot: '   ' }]) {
    assert.equal(rejected(input).code, 'INVALID_INPUT', JSON.stringify(input))
  }
})

test('driver local rejects relative roots, parent segments, control characters and over-long roots', () => {
  const bad = [
    'media/files',
    'D:media',
    '/data/../etc',
    'D:\\a\\..\\b',
    '/data/x\u0007y',
    '/' + 'a'.repeat(512),
  ]
  for (const localRoot of bad) {
    rejected({ driver: 'local', localRoot })
  }
})

test('driver local accepts a root of exactly 512 characters', () => {
  const localRoot = '/' + 'a'.repeat(511)
  assert.equal(localRoot.length, 512)
  assert.equal(accepted({ driver: 'local', localRoot }).localRoot, localRoot)
})

test('an unknown driver or a non-string driver is rejected', () => {
  rejected({ driver: 'nfs' })
  rejected({ driver: null })
  rejected({ driver: 42 })
})

test('a non-string localRoot is rejected', () => {
  rejected({ localRoot: 123 })
  rejected({ driver: 'local', localRoot: { path: '/srv' } })
})

test('s3 still validates a supplied localRoot, but does not require one', () => {
  rejected({ driver: 's3', localRoot: 'relative/path' })
  assert.equal(accepted({ driver: 's3' }).localRoot, undefined)
  assert.equal(accepted({ driver: 's3', localRoot: '/srv/kept-for-switch-back' }).localRoot, '/srv/kept-for-switch-back')
})

test('s3 keeps its existing field rules: bucket shape is still enforced', () => {
  rejected({ driver: 's3', bucket: 'Bad_Bucket' })
  assert.equal(accepted({ driver: 's3', bucket: 'assets-01' }).bucket, 'assets-01')
})

test('an empty secret clears it and a supplied secret is kept as a set action', () => {
  assert.deepEqual(accepted({ driver: 'local', localRoot: '/srv/m', secretAccessKey: '' }).secret, { kind: 'clear' })
  assert.deepEqual(accepted({ driver: 'local', localRoot: '/srv/m' }).secret, { kind: 'keep' })
  assert.deepEqual(accepted({ driver: 's3', secretAccessKey: 'NEW' }).secret, { kind: 'set', secret: 'NEW' })
})

test('unknown fields are still rejected', () => {
  rejected({ driver: 's3', unexpectedField: true })
})
