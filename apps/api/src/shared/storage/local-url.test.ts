import assert from 'node:assert/strict'
import test from 'node:test'
import { signLocalClaims, verifyLocalClaims } from './local-url'

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

test('a valid read claim verifies and any tampered field fails', () => {
  process.env.APP_MASTER_KEY = KEY
  const claims = { method: 'GET' as const, key: 'user/run/0-a.png', exp: 1_900_000_000 }
  const sig = signLocalClaims(claims)
  assert.equal(verifyLocalClaims(claims, sig), true)
  assert.equal(verifyLocalClaims({ ...claims, key: 'user/run/1-a.png' }, sig), false, 'tampered key')
  assert.equal(verifyLocalClaims({ ...claims, exp: claims.exp + 1 }, sig), false, 'tampered exp')
  assert.equal(verifyLocalClaims({ ...claims, key: 'user/run/0-a.png/' }, sig), false, 'trailing slash')
})

test('a read signature is not valid as an upload signature, and the reverse', () => {
  process.env.APP_MASTER_KEY = KEY
  const read = { method: 'GET' as const, key: 'k.png', exp: 1_900_000_000 }
  const upload = { method: 'POST' as const, key: 'k.png', exp: 1_900_000_000, contentType: 'image/png', maxBytes: 100 }
  const readSig = signLocalClaims(read)
  const uploadSig = signLocalClaims(upload)
  assert.equal(verifyLocalClaims({ ...read, method: 'POST', contentType: 'image/png', maxBytes: 100 }, readSig), false, 'wrong method')
  assert.equal(verifyLocalClaims(read, uploadSig), false)
})

test('an upload claim binds the exact content type and the byte limit', () => {
  process.env.APP_MASTER_KEY = KEY
  const claims = { method: 'POST' as const, key: 'k.png', exp: 1_900_000_000, contentType: 'image/png', maxBytes: 100 }
  const sig = signLocalClaims(claims)
  assert.equal(verifyLocalClaims(claims, sig), true)
  assert.equal(verifyLocalClaims({ ...claims, contentType: 'image/jpeg' }, sig), false, 'wrong content type')
  assert.equal(verifyLocalClaims({ ...claims, maxBytes: 101 }, sig), false, 'raised limit')
})

test('malformed or wrong-length signatures are rejected without comparison', () => {
  process.env.APP_MASTER_KEY = KEY
  const claims = { method: 'GET' as const, key: 'k', exp: 1 }
  assert.equal(verifyLocalClaims(claims, ''), false)
  assert.equal(verifyLocalClaims(claims, 'short'), false)
  assert.equal(verifyLocalClaims(claims, 'A'.repeat(43) + '='), false)
})

test('signing fails closed without APP_MASTER_KEY', () => {
  const saved = process.env.APP_MASTER_KEY
  delete process.env.APP_MASTER_KEY
  try {
    assert.throws(() => signLocalClaims({ method: 'GET', key: 'k', exp: 1 }))
  } finally {
    if (saved === undefined) delete process.env.APP_MASTER_KEY
    else process.env.APP_MASTER_KEY = saved
  }
})
