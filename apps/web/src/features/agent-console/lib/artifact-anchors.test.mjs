import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTs } from '../../../shared/services/mock-workspace-test-loader.mjs'

const { textArtifactAnchor, selectedTextAnchor, containedImageBounds, imagePointAnchor, videoTimeAnchor, artifactAnchorLabel, artifactMessageError } = loadTs(new URL('./artifact-anchors.ts', import.meta.url))

test('text anchors preserve UTF-16 offsets, repeated quotes, whitespace and literal markup', () => {
  const content = '😀 same\n same <b>&</b>'
  assert.deepEqual(textArtifactAnchor(content, 9, 13), { kind: 'text', start: 9, end: 13, quote: 'same' })
  assert.deepEqual(textArtifactAnchor(content, 0, 2), { kind: 'text', start: 0, end: 2, quote: '😀' })
  assert.equal(textArtifactAnchor(content, 1, 2), null)
  assert.equal(textArtifactAnchor(content, 0, 1), null)
  assert.equal(textArtifactAnchor(content, -1, 2), null)
  assert.equal(textArtifactAnchor(content, 2, 2), null)
  assert.equal(textArtifactAnchor(content, 3, 999), null)
  assert.equal(textArtifactAnchor(content, 2.5, 3), null)
  assert.equal(textArtifactAnchor(' '.repeat(3), 0, 3).quote, '   ')
  assert.equal(textArtifactAnchor('<b>&</b>', 0, 8).quote, '<b>&</b>')
  assert.equal(textArtifactAnchor('中'.repeat(11000), 0, 11000), null)
})

test('DOM selection anchors use range prefix offsets and reject selection outside the Artifact', () => {
  const textNode = {}
  const root = { contains: (node) => node === textNode }
  const prefix = { selectNodeContents(node) { assert.equal(node, root) }, setEnd(node, offset) { assert.equal(node, textNode); assert.equal(offset, 9) }, toString: () => '😀 same\n ' }
  const range = { startContainer: textNode, endContainer: textNode, startOffset: 9, cloneRange: () => prefix, toString: () => 'same' }
  const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range }
  assert.deepEqual(selectedTextAnchor(root, selection, '😀 same\n same'), { kind: 'text', start: 9, end: 13, quote: 'same' })
  assert.equal(selectedTextAnchor(root, { ...selection, isCollapsed: true }, '😀 same\n same'), null)
  assert.equal(selectedTextAnchor(root, { ...selection, getRangeAt: () => ({ ...range, endContainer: {} }) }, '😀 same\n same'), null)
  assert.equal(selectedTextAnchor(root, selection, 'something else'), null)
})

test('image points exclude contain letterboxing in both axes and follow resize', () => {
  const wide = { left: 10, top: 20, width: 400, height: 400 }
  assert.deepEqual(containedImageBounds(wide, 800, 400), { left: 10, top: 120, width: 400, height: 200 })
  assert.equal(imagePointAnchor(wide, 800, 400, 210, 50), null)
  assert.deepEqual(imagePointAnchor(wide, 800, 400, 210, 220), { kind: 'image_point', x: 0.5, y: 0.5 })
  assert.deepEqual(imagePointAnchor(wide, 800, 400, 410, 320), { kind: 'image_point', x: 1, y: 1 })
  assert.equal(imagePointAnchor(wide, 800, 400, 411, 220), null)
  assert.deepEqual(imagePointAnchor(wide, 400, 800, 110, 20), { kind: 'image_point', x: 0, y: 0 })
  assert.equal(imagePointAnchor(wide, 400, 800, 30, 220), null)
  assert.equal(imagePointAnchor(wide, 0, 800, 210, 220), null)
  assert.deepEqual(imagePointAnchor({ left: 0, top: 0, width: 200, height: 100 }, 800, 400, 50, 75), { kind: 'image_point', x: 0.25, y: 0.75 })
})

test('video positions use rounded milliseconds bounded by the immutable DTO duration', () => {
  assert.deepEqual(videoTimeAnchor(1.2345, 8000), { kind: 'video', timeMs: 1235 })
  assert.deepEqual(videoTimeAnchor(10, 8000), { kind: 'video', timeMs: 8000 })
  assert.equal(videoTimeAnchor(0, null), null)
  assert.equal(videoTimeAnchor(Number.NaN, 8000), null)
  assert.equal(videoTimeAnchor(-1, 8000), null)
  assert.match(artifactAnchorLabel({ kind: 'video', timeMs: 1235 }), /1\.24/)
  assert.match(artifactAnchorLabel({ kind: 'image_rect', x: 0.1, y: 0.2, width: 0.3, height: 0.4 }), /30% × 40%/)
})

test('private comment validation matches UTF-8 body limits without trimming submitted text', () => {
  assert.equal(artifactMessageError('  hello\n世界  '), null)
  assert.equal(artifactMessageError('a'.repeat(8000)), null)
  assert.ok(artifactMessageError('a'.repeat(8001)))
  assert.ok(artifactMessageError('中'.repeat(2667)))
  assert.ok(artifactMessageError(' \n '))
  assert.ok(artifactMessageError('\ud800'))
  assert.ok(artifactMessageError('\udc00'))
  assert.ok(artifactMessageError('bad\0text'))
})
