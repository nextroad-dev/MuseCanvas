import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { boundedLimit } from './pagination'

test('boundedLimit always produces a finite integer while retaining defaults and bounds', () => {
  const cases: Array<[string | null, number]> = [
    [null, 50], ['', 50], ['0', 50], ['garbage', 50], ['NaN', 50],
    ['1', 1], ['50', 50], ['100', 100], ['101', 100], ['-5', 1],
    ['1.9', 1], ['50.9', 50], ['0.9', 1], ['-0.9', 1], ['99.99', 99],
    ['Infinity', 100], ['-Infinity', 1], ['1e999', 100], ['-1e999', 1],
  ]
  for (const [raw, expected] of cases) {
    const url = new URL('https://example.invalid/api/admin/users')
    if (raw !== null) url.searchParams.set('limit', raw)
    const actual = boundedLimit(new NextRequest(url))
    assert.equal(actual, expected, `limit=${raw}`)
    assert.ok(Number.isFinite(actual) && Number.isInteger(actual))
    assert.ok(actual >= 1 && actual <= 100)
  }
})
