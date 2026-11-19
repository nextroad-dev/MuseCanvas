import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CANVAS_DEFAULT_TITLE,
  CANVAS_MAX_EDGES,
  CANVAS_MAX_NODES,
  CANVAS_MAX_PARAMETERS_BYTES,
  CANVAS_MAX_PARAMETERS_DEPTH,
  CANVAS_MAX_SCENE_BYTES,
  CANVAS_MAX_TEXT_LENGTH,
  CanvasErrorCode,
  isCanvasUuid,
  parseCanvasNode,
  parseCanvasParameters,
  parseCanvasScene,
  parseCreateCanvasRequest,
  parseUpdateCanvasRequest,
  type CanvasNode,
  type CanvasParseResult,
  type CanvasScene,
} from './canvas'

const id = (n: number) => `12345678-abcd-1234-1234-${n.toString(16).padStart(12, '0')}`
function note(n: number, text = ''): CanvasNode { return { id: id(n), type: 'note', position: { x: 0, y: -1 }, data: { text } } }
function fixture(): CanvasScene {
  return {
    nodes: [
      { id: id(1), type: 'prompt', position: { x: 1.5, y: -20 }, size: { width: 200, height: 100 }, data: { prompt: 'cat', modelId: id(10), parameters: { nested: { values: [1, true, null, 'hello'] } } } },
      { id: id(2), type: 'image', position: { x: 20, y: 30 }, data: { assetId: id(11), jobId: id(12), sourceNodeId: id(1), prompt: 'cat' } },
      { id: id(3), type: 'video', position: { x: 40, y: 30 }, data: { sourceNodeId: id(2), parameters: {} } },
      note(4, 'memo'),
    ],
    edges: [{ id: id(20), source: id(1), target: id(2) }, { id: id(21), source: id(2), target: id(3) }],
  }
}
function valid<T>(parsed: CanvasParseResult<T>): T {
  assert.equal(parsed.success, true, JSON.stringify(parsed))
  if (!parsed.success) throw new Error('Expected success')
  return parsed.data
}
function invalid<T>(parsed: CanvasParseResult<T>, code: CanvasErrorCode = CanvasErrorCode.INVALID_INPUT): void {
  assert.equal(parsed.success, false)
  if (parsed.success) throw new Error('Expected failure')
  assert.equal(parsed.error.code, code)
  assert.equal(typeof parsed.error.path, 'string')
  assert.ok(parsed.error.message)
}

test('canvas UUIDs, all node kinds and detached normalized scenes', () => {
  assert.equal(isCanvasUuid(id(1)), true)
  assert.equal(isCanvasUuid(id(1).toUpperCase()), true)
  for (const value of ['', 1, null, 'not-a-uuid', `${id(1)}x`]) assert.equal(isCanvasUuid(value), false)
  const input = fixture()
  input.nodes[0]!.id = id(1).toUpperCase()
  const output = valid(parseCanvasScene(input))
  assert.equal(output.nodes[0]!.id, id(1))
  assert.notEqual(output, input)
  assert.notEqual(output.nodes[0]!.data, input.nodes[0]!.data)
  assert.deepEqual(valid(parseCanvasNode(note(1))), note(1))
})

test('scene strict fields reject URLs, unknown kinds, null/undefined and forbidden keys', () => {
  for (const value of [null, [], {}, { nodes: [], edges: [], viewport: {} }, { nodes: [], edges: [], signedUrl: 'https://example.test' }]) invalid(parseCanvasScene(value))
  for (const node of [
    { ...note(1), type: 'other' },
    { ...note(1), selected: true },
    { ...note(1), data: { text: 'x', assetId: id(2) } },
    { ...note(1), data: { text: undefined } },
    { ...note(1), data: { text: null } },
    { ...note(1), data: { text: '', url: 'https://example.test?signed=secret' } },
    { ...note(1), data: JSON.parse('{"text":"","__proto__":{}}') },
    { ...note(1), data: { text: '', constructor: {} } },
    { ...note(1), data: { text: '', prototype: {} } },
    { ...note(1), id: 'bad' },
    { ...note(1), type: 'prompt', data: {} },
    { ...note(1), type: 'image', data: { assetId: null } },
    { ...note(1), type: 'video', data: { sourceNodeId: 'bad' } },
  ]) invalid(parseCanvasScene({ nodes: [node], edges: [] }))
  for (const field of ['url', 'signedUrl', 'downloadUrl', 'thumbnailUrl']) {
    invalid(parseCanvasNode({ ...note(1), type: 'image', data: { assetId: id(2), [field]: 'https://example.test?signature=secret' } }))
  }
})

test('scene finite positions and positive finite optional size are enforced', () => {
  for (const position of [{ x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 0, y: -Infinity }, { x: '0', y: 0 }, { x: 0 }, { x: 0, y: 0, z: 0 }]) invalid(parseCanvasNode({ ...note(1), position }))
  for (const size of [null, { width: 0, height: 1 }, { width: -1, height: 1 }, { width: Infinity, height: 1 }, { width: 1 }, { width: 1, height: 1, extra: true }]) invalid(parseCanvasNode({ ...note(1), size }))
  valid(parseCanvasNode({ ...note(1), size: { width: 0.5, height: 1.5 } }))
})

test('scene references and node/edge identities must be unique, including UUID case', () => {
  const input = fixture()
  invalid(parseCanvasScene({ ...input, nodes: [...input.nodes, { ...note(1), id: id(1).toUpperCase() }] }), CanvasErrorCode.CANVAS_DUPLICATE_NODE_ID)
  invalid(parseCanvasScene({ ...input, edges: [...input.edges, input.edges[0]] }), CanvasErrorCode.CANVAS_DUPLICATE_EDGE_ID)
  invalid(parseCanvasScene({ ...input, edges: [{ id: id(30), source: id(1), target: id(99) }] }), CanvasErrorCode.CANVAS_DANGLING_REFERENCE)
  invalid(parseCanvasScene({ nodes: [{ ...note(1), type: 'image', data: { sourceNodeId: id(99) } }], edges: [] }), CanvasErrorCode.CANVAS_DANGLING_REFERENCE)
  invalid(parseCanvasScene({ ...input, edges: [{ id: id(30), source: 'bad', target: id(1) }] }))
  invalid(parseCanvasScene({ ...input, edges: [{ id: id(30), source: id(1), target: id(2), label: 'x' }] }))
})

test('persistent strings reject PostgreSQL NUL and unpaired surrogates, but accept Unicode pairs', () => {
  for (const value of ['\u0000', '\ud800', '\udfff', 'x\ud800y', 'x\udfffy']) {
    assert.equal(parseCreateCanvasRequest({ title: value }).success, false)
    assert.equal(parseCanvasScene({ nodes: [note(1, value)], edges: [] }).success, false)
    assert.equal(parseCanvasParameters({ key: value }).success, false)
    assert.equal(parseCanvasParameters({ [value]: 'text' }).success, false)
  }
  assert.equal(parseCreateCanvasRequest({ title: '猫😺' }).success, true)
  assert.equal(parseCanvasScene({ nodes: [note(1, '😺猫')], edges: [] }).success, true)
  assert.equal(parseCanvasParameters({ '😺': '猫😺' }).success, true)
})

test('scene count and prompt/note text limits include their boundary', () => {
  valid(parseCanvasScene({ nodes: Array.from({ length: CANVAS_MAX_NODES }, (_, i) => note(i)), edges: [] }))
  invalid(parseCanvasScene({ nodes: Array.from({ length: CANVAS_MAX_NODES + 1 }, (_, i) => note(i)), edges: [] }), CanvasErrorCode.CANVAS_NODE_LIMIT_EXCEEDED)
  const edges = Array.from({ length: CANVAS_MAX_EDGES }, (_, i) => ({ id: id(i + 100), source: id(1), target: id(2) }))
  valid(parseCanvasScene({ nodes: [note(1), note(2)], edges }))
  invalid(parseCanvasScene({ nodes: [note(1), note(2)], edges: [...edges, { id: id(9999), source: id(1), target: id(2) }] }), CanvasErrorCode.CANVAS_EDGE_LIMIT_EXCEEDED)
  for (const type of ['note', 'prompt', 'image', 'video'] as const) {
    const key = type === 'note' ? 'text' : 'prompt'
    valid(parseCanvasNode({ ...note(1), type, data: { [key]: 'x'.repeat(CANVAS_MAX_TEXT_LENGTH) } }))
    invalid(parseCanvasNode({ ...note(1), type, data: { [key]: 'x'.repeat(CANVAS_MAX_TEXT_LENGTH + 1) } }))
  }
})

test('scene size is serialized UTF-8 bytes, not string length, with exact boundary', () => {
  const scene: CanvasScene = { nodes: Array.from({ length: 12 }, (_, i) => note(i, '猫'.repeat(14_000))), edges: [] }
  const utf8Bytes = () => new TextEncoder().encode(JSON.stringify(scene)).byteLength
  let remaining = CANVAS_MAX_SCENE_BYTES - utf8Bytes()
  for (const node of scene.nodes) {
    if (node.type !== 'note') throw new Error('Expected note')
    const fill = Math.min(remaining, CANVAS_MAX_TEXT_LENGTH - node.data.text.length)
    node.data.text += 'x'.repeat(fill)
    remaining -= fill
  }
  assert.equal(remaining, 0)
  assert.equal(utf8Bytes(), CANVAS_MAX_SCENE_BYTES)
  assert.ok(JSON.stringify(scene).length < CANVAS_MAX_SCENE_BYTES)
  valid(parseCanvasScene(scene))
  const last = scene.nodes.at(-1)!
  if (last.type !== 'note') throw new Error('Expected note')
  last.data.text += 'x'
  invalid(parseCanvasScene(scene), CanvasErrorCode.CANVAS_SCENE_TOO_LARGE)
})

test('parameters are JSON-safe, detached, plain, bounded, and reject prototype keys recursively', () => {
  valid(parseCanvasParameters({ value: [null, false, 'x', 1.2, { a: 2 }] }))
  for (const value of [[], null, { bad: undefined }, { bad: NaN }, { bad: Infinity }, { bad: 1n }, { bad: () => 1 }, { bad: Symbol('x') }, { bad: new Date() }, Object.create({ inherited: true }), { bad: JSON.parse('{"__proto__":{}}') }, { bad: { constructor: 'x' } }, { bad: { prototype: 'x' } }]) invalid(parseCanvasParameters(value))
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  invalid(parseCanvasParameters(cyclic))
  invalid(parseCanvasParameters({ values: Array(4096).fill(null) }))
  let deep: unknown = 1
  for (let i = 0; i < CANVAS_MAX_PARAMETERS_DEPTH; i++) deep = { value: deep }
  valid(parseCanvasParameters(deep))
  invalid(parseCanvasParameters({ value: deep }))
  const overhead = new TextEncoder().encode(JSON.stringify({ value: '' })).byteLength
  valid(parseCanvasParameters({ value: 'x'.repeat(CANVAS_MAX_PARAMETERS_BYTES - overhead) }))
  invalid(parseCanvasParameters({ value: 'x'.repeat(CANVAS_MAX_PARAMETERS_BYTES - overhead + 1) }))
})

test('parsers never expose raw exceptions and reject accessors, symbols, sparse/custom arrays', () => {
  const getter = Object.defineProperty({}, 'nodes', { enumerable: true, get() { throw new Error('secret') } })
  invalid(parseCanvasScene(getter))
  invalid(parseCanvasScene(new Proxy({}, { ownKeys() { throw new Error('secret') } })))
  invalid(parseCanvasScene({ nodes: [], edges: [], [Symbol('x')]: true }))
  invalid(parseCanvasParameters(Object.defineProperty({}, 'hidden', { value: 1 })))
  invalid(parseCanvasParameters({ values: new Array(2) }))
  invalid(parseCanvasParameters({ values: Object.assign([], { extra: true }) }))
  class CustomArray extends Array<unknown> {}
  invalid(parseCanvasParameters({ values: new CustomArray() }))
  const values = [1]
  Object.defineProperty(values, '0', { enumerable: true, get() { throw new Error('secret') } })
  invalid(parseCanvasParameters({ values }))
})

test('create request defaults, trimmed title, UUID cover and scene validation', () => {
  assert.deepEqual(valid(parseCreateCanvasRequest({})), { title: CANVAS_DEFAULT_TITLE, scene: { nodes: [], edges: [] }, coverAssetId: null })
  assert.equal(valid(parseCreateCanvasRequest({ title: '  画布  ' })).title, '画布')
  assert.equal(valid(parseCreateCanvasRequest({ coverAssetId: id(10).toUpperCase() })).coverAssetId, id(10))
  valid(parseCreateCanvasRequest({ title: 'x'.repeat(120), scene: fixture(), coverAssetId: null }))
  for (const value of [{ title: ' ' }, { title: 'x'.repeat(121) }, { title: undefined }, { coverAssetId: 'bad' }, { scene: {} }, { revision: 1 }, { signedUrl: 'x' }]) invalid(parseCreateCanvasRequest(value))
})

test('update requires nonempty patch and positive safe revision', () => {
  valid(parseUpdateCanvasRequest({ baseRevision: Number.MAX_SAFE_INTEGER, title: ' x ' }))
  valid(parseUpdateCanvasRequest({ baseRevision: 1, coverAssetId: null }))
  valid(parseUpdateCanvasRequest({ baseRevision: 1, scene: { nodes: [], edges: [] } }))
  for (const value of [{ baseRevision: 1 }, { title: 'x' }, { title: 'x', baseRevision: 0 }, { title: 'x', baseRevision: 1.5 }, { title: 'x', baseRevision: Number.MAX_SAFE_INTEGER + 1 }, { title: 'x', baseRevision: '1' }, { baseRevision: 1, title: 'x', revision: 2 }]) invalid(parseUpdateCanvasRequest(value))
})
