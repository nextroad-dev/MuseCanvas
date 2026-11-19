import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { body, MalformedBodyError } from './http'
import { requestOtp, verifyOtp } from '../modules/auth/handlers'
import type { PublicContext } from '../router/types'

const request = (raw: string) => new NextRequest('https://example.invalid/api/auth/otp/request', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
})

for (const raw of ['null', '[]', '[{"email":"user@example.com"}]', '"text"', '42', 'true', '{', '']) {
  test(`body rejects non-object or malformed JSON instead of returning {}: ${JSON.stringify(raw)}`, async () => {
    await assert.rejects(body(request(raw)), MalformedBodyError)
  })

  test(`OTP handlers surface the shared rejection before any I/O: ${JSON.stringify(raw)}`, async () => {
    for (const handler of [requestOtp, verifyOtp]) {
      const req = request(raw)
      const context: PublicContext = { request: req, actor: undefined, path: '', params: {}, json: () => body(req) }
      await assert.rejects(handler(context), MalformedBodyError)
    }
  })
}

test('an empty JSON object still reaches the OTP handlers and fails validation without I/O', async () => {
  // A request body is a one-shot stream, so each handler gets a fresh request.
  const otpContext = () => {
    const req = request('{}')
    return { request: req, actor: undefined, path: '', params: {}, json: () => body(req) } as PublicContext
  }
  const requested = await requestOtp(otpContext())
  assert.equal(requested.status, 400)
  const requestPayload = await requested.json()
  assert.equal(requestPayload.success, false)
  assert.equal(requestPayload.error.code, 'INVALID_INPUT')
  assert.equal(typeof requestPayload.error.message, 'string')
  const verified = await verifyOtp(otpContext())
  assert.equal(verified.status, 400)
  assert.equal((await verified.json()).error.code, 'INVALID_OTP')
})

test('body preserves JSON objects and nested values', async () => {
  const input = { email: 'user@example.com', nested: { values: [null, 1] }, enabled: false }
  assert.deepEqual(await body(request(JSON.stringify(input))), input)
  assert.deepEqual(await body(request('{}')), {})
})
