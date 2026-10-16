import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeFlipDelta, planFlipDeltas, prefersReducedMotion } from '../lib/flip.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

test('computeFlipDelta: the translate that carries an element from its old slot to its new one', () => {
  assert.deepEqual(computeFlipDelta({ left: 10, top: 100 }, { left: 10, top: 40 }), { dx: 0, dy: 60 })
  assert.deepEqual(computeFlipDelta({ left: 0, top: 0 }, { left: 120, top: 0 }), { dx: -120, dy: 0 })
  assert.deepEqual(computeFlipDelta({ left: 5, top: 5 }, { left: 5, top: 5 }), { dx: 0, dy: 0 })
})

test('planFlipDeltas: an unchanged order plans nothing, so the hook animates nothing', () => {
  const planned = planFlipDeltas(
    ['a', 'b', 'c'].map((key, index) => ({
      key,
      prev: { left: 0, top: index * 48 },
      curr: { left: 0, top: index * 48 },
    })),
  )
  assert.deepEqual(planned, [])
})

test('planFlipDeltas: only the moved item is planned, with its translate delta; newcomers are skipped', () => {
  const planned = planFlipDeltas([
    { key: 'a', prev: { left: 0, top: 0 }, curr: { left: 0, top: 0 } },
    { key: 'b', prev: { left: 0, top: 48 }, curr: { left: 0, top: 96 } },
    { key: 'fresh', prev: undefined, curr: { left: 0, top: 144 } },
  ])
  assert.deepEqual(planned, [{ key: 'b', dx: 0, dy: -48 }])
})

test('prefersReducedMotion: follows matchMedia, defaults to false without a window', () => {
  const previousWindow = globalThis.window
  try {
    globalThis.window = { matchMedia: (query) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query }) }
    assert.equal(prefersReducedMotion(), true)
    globalThis.window = { matchMedia: () => ({ matches: false }) }
    assert.equal(prefersReducedMotion(), false)
    delete globalThis.window
    assert.equal(prefersReducedMotion(), false)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('useFlipList: reduced motion returns before any animate call', () => {
  // The hook body cannot run under node --test (React + DOM), so the wiring is
  // pinned by source: the reduced-motion gate must precede the animate call.
  const hookSource = fs.readFileSync(path.join(HERE, 'useFlipList.ts'), 'utf8')
  assert.match(hookSource, /prefersReducedMotion\(\)/)
  assert.match(hookSource, /\.animate\(/)
  assert.ok(
    hookSource.indexOf('if (prefersReducedMotion()) return') !== -1
    && hookSource.indexOf('if (prefersReducedMotion()) return') < hookSource.indexOf('.animate('),
    'the reduced-motion early return must come before the animate call',
  )
})
