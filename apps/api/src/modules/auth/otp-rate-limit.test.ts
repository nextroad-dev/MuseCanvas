import assert from 'node:assert/strict'
import test from 'node:test'
import { otpRequestLimited } from './handlers'

test('OTP request keeps pair budget and enforces independent IP and mailbox budgets', async () => {
  const counts = new Map<string, number>()
  const check = async (key: string, max: number, seconds: number) => {
    assert.equal(seconds, 600)
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    return count > max
  }
  for (let i = 0; i < 5; i++) assert.equal(await otpRequestLimited('fixture@example.invalid', `ip-${i}`, check), false)
  assert.equal(await otpRequestLimited('fixture@example.invalid', 'another-ip', check), true)
  counts.clear()
  for (let i = 0; i < 30; i++) assert.equal(await otpRequestLimited(`fixture-${i}@example.invalid`, 'same-ip', check), false)
  assert.equal(await otpRequestLimited('last@example.invalid', 'same-ip', check), true)
  assert.equal(counts.get('otp:ip:same-ip'), 31)
  assert.equal(counts.get('otp:last@example.invalid:same-ip'), 1)
})
