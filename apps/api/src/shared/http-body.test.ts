import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { body } from './http'
import { requestOtp, verifyOtp } from '../modules/auth/handlers'
import type { PublicContext } from '../router/types'

const request = (raw: string) => new NextRequest('https://example.invalid/api/auth/otp/request', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
})

for (const raw of ['null', '[]', '[{"email":"user@example.com"}]', '"text"', '42', 'true', '{', '']) {
  test(`body normalizes non-object or malformed JSON: ${JSON.stringify(raw)}`, async () => {
    assert.deepEqual(await body(request(raw)), {})
  })

  test(`OTP endpoints return structured 400 without I/O: ${JSON.stringify(raw)}`, async () => {
    for (const [handler, code] of [[requestOtp, 'INVALID_INPUT'], [verifyOtp, 'INVALID_OTP']] as const) {
      const req = request(raw)
      const context: PublicContext = { request: req, actor: undefined, path: '', params: {}, json: () => body(req) }
      const response = await handler(context)
      assert.equal(response.status, 400)
      const payload = await response.json()
      assert.equal(payload.success, false)
      assert.equal(payload.error.code, code)
      assert.equal(typeof payload.error.message, 'string')
    }
  })
}

test('body preserves JSON objects and nested values', async () => {
  const input = { email: 'user@example.com', nested: { values: [null, 1] }, enabled: false }
  assert.deepEqual(await body(request(JSON.stringify(input))), input)
  assert.deepEqual(await body(request('{}')), {})
})
