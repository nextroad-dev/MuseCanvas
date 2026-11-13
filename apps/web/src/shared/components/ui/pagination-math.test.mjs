import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPageItems, clampPage, describeRange } from './pagination-math.ts'

test('buildPageItems keeps first/last pages and the window around current', () => {
  const items = buildPageItems(5, 10, 1)
  assert.deepEqual(
    items.map((item) => (item.kind === 'page' ? item.page : '…')),
    [1, '…', 4, 5, 6, '…', 10],
  )
})

test('buildPageItems collapses to a short list near the edges', () => {
  assert.deepEqual(
    buildPageItems(1, 10, 1).map((item) => (item.kind === 'page' ? item.page : '…')),
    [1, 2, '…', 10],
  )
  assert.deepEqual(
    buildPageItems(10, 10, 1).map((item) => (item.kind === 'page' ? item.page : '…')),
    [1, '…', 9, 10],
  )
})

test('buildPageItems handles a single page and clamps out-of-range input', () => {
  assert.deepEqual(buildPageItems(1, 1), [{ kind: 'page', page: 1 }])
  assert.deepEqual(
    buildPageItems(0, 3, 0).map((item) => (item.kind === 'page' ? item.page : '…')),
    [1, '…', 3],
  )
})

test('describeRange reports the visible slice', () => {
  assert.equal(describeRange(1, 20, 128), '第 1–20 条，共 128 条')
  assert.equal(describeRange(2, 20, 128), '第 21–40 条，共 128 条')
  assert.equal(describeRange(7, 20, 128), '第 121–128 条，共 128 条')
  assert.equal(describeRange(1, 20, 0), '共 0 条')
})

test('clampPage keeps the page inside the valid range', () => {
  assert.equal(clampPage(0, 5), 1)
  assert.equal(clampPage(9, 5), 5)
  assert.equal(clampPage(3, 5), 3)
  assert.equal(clampPage(2, 0), 1)
})
