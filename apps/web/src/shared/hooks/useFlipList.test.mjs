import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeFlipDelta, planFlipDeltas, prefersReducedMotion } from './useFlipList.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

test('computeFlipDelta: 把元素从旧位置搬到新位置的 translate', () => {
  assert.deepEqual(computeFlipDelta({ left: 10, top: 100 }, { left: 10, top: 40 }), { dx: 0, dy: 60 })
  assert.deepEqual(computeFlipDelta({ left: 0, top: 0 }, { left: 120, top: 0 }), { dx: -120, dy: 0 })
  assert.deepEqual(computeFlipDelta({ left: 5, top: 5 }, { left: 5, top: 5 }), { dx: 0, dy: 0 })
})

test('planFlipDeltas: 顺序没变时计划为空，hook 不发动画', () => {
  const planned = planFlipDeltas(
    ['a', 'b', 'c'].map((key, index) => ({
      key,
      prev: { left: 0, top: index * 48 },
      curr: { left: 0, top: index * 48 },
    })),
  )
  assert.deepEqual(planned, [])
})

test('planFlipDeltas: 只计划真正移动的项，新加入项跳过', () => {
  const planned = planFlipDeltas([
    { key: 'a', prev: { left: 0, top: 0 }, curr: { left: 0, top: 0 } },
    { key: 'b', prev: { left: 0, top: 48 }, curr: { left: 0, top: 96 } },
    { key: 'fresh', prev: undefined, curr: { left: 0, top: 144 } },
  ])
  assert.deepEqual(planned, [{ key: 'b', dx: 0, dy: -48 }])
})

test('planFlipDeltas: 容器内滚动（相对坐标不变）不会被误判为重排', () => {
  const planned = planFlipDeltas([
    { key: 'row-1', prev: { left: 0, top: 0 }, curr: { left: 0, top: 0 } },
    { key: 'row-2', prev: { left: 0, top: 32 }, curr: { left: 0, top: 32 } },
  ])
  assert.deepEqual(planned, [])
})

test('prefersReducedMotion: 跟随 matchMedia，没有 window 时为 false', () => {
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

test('useFlipList: 减少动效的早退必须出现在 animate 调用之前', () => {
  // hook 本体依赖 React + DOM，无法在 node --test 里执行；这里用源码顺序锁定约束：
  // 先 matchMedia 早退，再调用 .animate（唯一允许的 WAAPI 调用点）。
  const hookSource = fs.readFileSync(path.join(HERE, 'useFlipList.ts'), 'utf8')
  assert.match(hookSource, /prefersReducedMotion\(\)/)
  assert.match(hookSource, /\.animate\(/)
  assert.ok(
    hookSource.indexOf('if (prefersReducedMotion()) return') !== -1 &&
      hookSource.indexOf('if (prefersReducedMotion()) return') < hookSource.indexOf('.animate('),
    '减少动效的早退必须位于 animate 调用之前',
  )
  assert.match(hookSource, /activeAnimations\.current\.get\(element\)/)
  assert.match(hookSource, /running\.cancel\(\)/)
})
