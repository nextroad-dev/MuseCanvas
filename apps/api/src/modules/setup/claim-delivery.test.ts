import assert from 'node:assert/strict'
import test from 'node:test'

import { formatClaimLogBlock, resolveClaimDelivery } from './claim-delivery'

test('an unset mode defaults to file when SETUP_CLAIM_FILE is set, in any environment', () => {
  assert.deepEqual(resolveClaimDelivery({ SETUP_CLAIM_FILE: '/run/secrets/claim' }), { mode: 'file', file: '/run/secrets/claim' })
  assert.deepEqual(
    resolveClaimDelivery({ NODE_ENV: 'production', SETUP_CLAIM_FILE: '/run/secrets/claim' }),
    { mode: 'file', file: '/run/secrets/claim' },
  )
})

test('an unset mode defaults to log outside production when no file is configured', () => {
  assert.deepEqual(resolveClaimDelivery({}), { mode: 'log' })
  assert.deepEqual(resolveClaimDelivery({ NODE_ENV: 'development' }), { mode: 'log' })
  assert.deepEqual(resolveClaimDelivery({ NODE_ENV: 'test' }), { mode: 'log' })
})

test('an unset mode in production without a file mints nothing and reports why', () => {
  const delivery = resolveClaimDelivery({ NODE_ENV: 'production' })
  assert.equal(delivery.mode, 'off')
  assert.match(delivery.mode === 'off' ? delivery.problem ?? '' : '', /SETUP_CLAIM_FILE/)
})

test('a blank SETUP_CLAIM_FILE counts as unset', () => {
  assert.deepEqual(resolveClaimDelivery({ SETUP_CLAIM_FILE: '   ', NODE_ENV: 'development' }), { mode: 'log' })
  assert.equal(resolveClaimDelivery({ SETUP_CLAIM_FILE: '  ', NODE_ENV: 'production' }).mode, 'off')
})

test('an explicit log mode is honoured in production', () => {
  assert.deepEqual(resolveClaimDelivery({ NODE_ENV: 'production', SETUP_CLAIM_DELIVERY: 'log' }), { mode: 'log' })
})

test('an explicit off mode mints nothing and reports no problem, even outside production', () => {
  assert.deepEqual(resolveClaimDelivery({ NODE_ENV: 'development', SETUP_CLAIM_DELIVERY: 'off' }), { mode: 'off' })
  assert.deepEqual(
    resolveClaimDelivery({ NODE_ENV: 'production', SETUP_CLAIM_DELIVERY: 'off', SETUP_CLAIM_FILE: '/x' }),
    { mode: 'off' },
  )
})

test('an explicit file mode uses the configured file, in any environment', () => {
  assert.deepEqual(
    resolveClaimDelivery({ NODE_ENV: 'production', SETUP_CLAIM_DELIVERY: 'file', SETUP_CLAIM_FILE: '/run/claim' }),
    { mode: 'file', file: '/run/claim' },
  )
})

test('an explicit file mode without SETUP_CLAIM_FILE fails closed with a problem', () => {
  const delivery = resolveClaimDelivery({ NODE_ENV: 'development', SETUP_CLAIM_DELIVERY: 'file' })
  assert.equal(delivery.mode, 'off')
  assert.match(delivery.mode === 'off' ? delivery.problem ?? '' : '', /requires SETUP_CLAIM_FILE/)
})

test('an unknown mode fails closed with a problem and never falls back to log', () => {
  for (const raw of ['stdout', 'console', 'on', 'files']) {
    const delivery = resolveClaimDelivery({ NODE_ENV: 'development', SETUP_CLAIM_DELIVERY: raw })
    assert.equal(delivery.mode, 'off', raw)
    assert.match(delivery.mode === 'off' ? delivery.problem ?? '' : '', /file, log or off/, raw)
  }
})

test('the mode name is case-insensitive and trimmed', () => {
  assert.deepEqual(resolveClaimDelivery({ NODE_ENV: 'production', SETUP_CLAIM_DELIVERY: '  LOG ' }), { mode: 'log' })
  assert.deepEqual(resolveClaimDelivery({ SETUP_CLAIM_DELIVERY: 'Off' }), { mode: 'off' })
})

test('the log block carries the code, expiry and rules on one delimited block', () => {
  const block = formatClaimLogBlock({
    code: 'abc123',
    expiresAt: '2026-10-20T10:15:00.000Z',
    ttlMinutes: 15,
    maxAttempts: 5,
  })
  const lines = block.split('\n')
  assert.equal(lines.length, 3)
  assert.equal(lines[0], lines[2])
  assert.match(lines[0], /^=+$/)
  assert.equal(
    lines[1],
    '[MUSECANVAS SETUP CLAIM] code=abc123 expires=2026-10-20T10:15:00.000Z (single use, 15 minutes, 5 attempts; delete this log line after use)',
  )
})
