import assert from 'node:assert/strict'
import test from 'node:test'
import type { JsonValue } from '@musecanvas/contracts'
import { canonicalJsonDigest } from './canonical-json-digest'

// Captured from the previous implementation before removing the old runtime.
// A changed hash would break replay, approval binding and persisted checkpoints.
const vectors: Array<[JsonValue, string]> = [
  [null, '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'],
  [{}, '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'],
  [{ b: 2, a: [1, 2] }, '68b7e88ecdcf999e2736835f0354c02ff937e5c4222e67f38d1fa2682a5c15aa'],
  [{ '2': 'two', '10': 'ten', nested: { z: '猫😺', a: 'quote"\\n' } }, '77b1a17ed5af5b0cd83a45f353f1ccc5f5caee299f4a773e7e1539e91b25d34e'],
  [[1, 2], '49a64717d5d4cb19952e6eac2946415cf6879adacf9908e7d872332d32c6e684'],
  [[2, 1], 'af1a1fc110b6094c48582b0ef83553cb7908d7a4365424eef28e76ef6c88d630'],
]

test('canonical JSON digest preserves persisted identities including numeric keys and Unicode', () => {
  for (const [value, expected] of vectors) assert.equal(canonicalJsonDigest(value), expected)
})

test('canonical JSON digest ignores object insertion order but preserves nested array order', () => {
  assert.equal(canonicalJsonDigest({ b: 2, a: [1, 2] }), canonicalJsonDigest({ a: [1, 2], b: 2 }))
  assert.equal(canonicalJsonDigest({ nested: { b: false, a: null } }), canonicalJsonDigest({ nested: { a: null, b: false } }))
  assert.notEqual(canonicalJsonDigest([1, 2]), canonicalJsonDigest([2, 1]))
})
