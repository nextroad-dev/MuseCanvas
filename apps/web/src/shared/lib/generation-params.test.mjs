import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_GENERATION_COUNT,
  MAX_GENERATION_COUNT,
  buildGenerationInputs,
  formatSizeLabel,
  newIdempotencyKey,
  normalizeCount,
  normalizeParameters,
  parseAspectRatio,
  parseDurationSeconds,
  parseGenerationParams,
  parseSize,
  reduceRatio,
} from './generation-params.ts'

test('reduceRatio 约分宽高比', () => {
  assert.equal(reduceRatio(1024, 768), '4:3')
  assert.equal(reduceRatio(900, 1600), '9:16')
  assert.equal(reduceRatio(0, 100), null)
})

test('parseSize 解析像素尺寸，拒绝 auto/非法值', () => {
  assert.deepEqual(parseSize('1024x1365'), { width: 1024, height: 1365, ratio: '1024:1365' })
  assert.deepEqual(parseSize('1600 × 900'), { width: 1600, height: 900, ratio: '16:9' })
  assert.equal(parseSize('auto'), null)
  assert.equal(parseSize('3:4'), null)
  assert.equal(parseSize(undefined), null)
})

test('parseAspectRatio 解析比例写法', () => {
  assert.equal(parseAspectRatio('3:4'), '3:4')
  assert.equal(parseAspectRatio('16 / 9'), '16:9')
  assert.equal(parseAspectRatio('nope'), null)
})

test('parseGenerationParams 汇总画幅/张数/时长/质量', () => {
  const parsed = parseGenerationParams({
    parameters: { size: '3:4', count: 2, duration: 5, quality: 'high' },
  })
  assert.equal(parsed.size, '3:4')
  assert.equal(parsed.aspectRatio, '3:4')
  assert.equal(parsed.count, 2)
  assert.equal(parsed.durationSeconds, 5)
  assert.equal(parsed.quality, 'high')
})

test('parseGenerationParams 兼容顶层 size/count 与 duration_s', () => {
  const parsed = parseGenerationParams({ size: '1024x768', count: 3, parameters: { duration_s: '8' } })
  assert.equal(parsed.aspectRatio, '4:3')
  assert.equal(parsed.count, 3)
  assert.equal(parsed.durationSeconds, 8)
})

test('normalizeCount 收敛到 1..MAX_GENERATION_COUNT', () => {
  assert.equal(normalizeCount(undefined), DEFAULT_GENERATION_COUNT)
  assert.equal(normalizeCount('abc'), DEFAULT_GENERATION_COUNT)
  assert.equal(normalizeCount(0), 1)
  assert.equal(normalizeCount(-5), 1)
  assert.equal(normalizeCount(99), MAX_GENERATION_COUNT)
  assert.equal(normalizeCount('4'), 4)
})

test('parseDurationSeconds 解析秒数并封顶', () => {
  assert.equal(parseDurationSeconds(5), 5)
  assert.equal(parseDurationSeconds('5s'), 5)
  assert.equal(parseDurationSeconds(0), null)
  assert.equal(parseDurationSeconds(999), 60)
})

test('formatSizeLabel 输出「画幅 · 尺寸 · 张数」，缺项省略', () => {
  assert.equal(formatSizeLabel('3:4'), '3:4')
  assert.equal(formatSizeLabel('1024x1365'), '1024:1365 · 1024 × 1365')
  assert.equal(formatSizeLabel('1024x1365', 2), '1024:1365 · 1024 × 1365 · 2 张')
  assert.equal(formatSizeLabel(null), '默认画幅')
})

test('buildGenerationInputs 过滤空引用并重排 position', () => {
  const inputs = buildGenerationInputs([
    { uploadId: 'u1', role: 'reference_image' },
    { assetId: null, uploadId: null },
    { assetId: 'a1', role: 'first_frame', position: 7 },
  ])
  assert.deepEqual(inputs, [
    { uploadId: 'u1', role: 'reference_image', position: 0 },
    { assetId: 'a1', role: 'first_frame', position: 1 },
  ])
})

test('normalizeParameters 丢弃空值与非标量', () => {
  assert.deepEqual(normalizeParameters({ a: 1, b: 'x', c: true, d: null, e: undefined, f: { x: 1 } }), {
    a: 1,
    b: 'x',
    c: true,
  })
  assert.equal(normalizeParameters({}), undefined)
})

test('newIdempotencyKey 产出唯一键', () => {
  const first = newIdempotencyKey()
  const second = newIdempotencyKey()
  assert.equal(typeof first, 'string')
  assert.ok(first.length > 8)
  assert.notEqual(first, second)
})
