import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { boundedLimit } from './pagination'

const requestWith = (search: string) => new NextRequest(new URL(`https://example.invalid/api/admin/users${search}`))

test('boundedLimit defaults to 50 when the parameter is absent', () => {
  assert.equal(boundedLimit(requestWith('')), 50)
  assert.equal(boundedLimit(requestWith('?cursor=x')), 50)
})

test('boundedLimit accepts integers within [1,100]', () => {
  for (const [raw, expected] of [['1', 1], ['9', 9], ['50', 50], ['99', 99], ['100', 100]] as const) {
    assert.equal(boundedLimit(requestWith(`?limit=${raw}`)), expected, `limit=${raw}`)
  }
})

/**
 * Aligned with the agent routes: anything that is not an integer
 * in [1,100] is rejected (null → the caller answers 400), not silently
 * clamped. The old Math.min/Math.max clamp turned `limit=101` into 100 and
 * `limit=garbage` into 50, so two routes disagreed on the same input.
 */
test('boundedLimit rejects malformed, out-of-range and non-integer values', () => {
  for (const raw of ['', '0', '-5', '101', '1.9', '50.9', '0.9', '-0.9', '99.99',
    'garbage', 'NaN', 'Infinity', '-Infinity', '1e999', '1e2', '099', '1 0', '⑤']) {
    assert.equal(boundedLimit(requestWith(`?limit=${encodeURIComponent(raw)}`)), null, `limit=${raw}`)
  }
})
