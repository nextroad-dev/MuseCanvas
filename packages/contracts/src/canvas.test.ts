import { parseCanvasAgentEditMetadata } from './canvas'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CANVAS_AGENT_SETTINGS_DEFAULTS,
  CANVAS_DEFAULT_TITLE,
  CANVAS_MAX_EDGES,
  CANVAS_MAX_NODES,
  CANVAS_MAX_OPS,
  CANVAS_MAX_PARAMETERS_BYTES,
  CANVAS_MAX_PARAMETERS_DEPTH,
  CANVAS_MAX_SCENE_BYTES,
  CANVAS_MAX_TEXT_LENGTH,
  CanvasErrorCode,
  applyCanvasOps,
  isCanvasUuid,
  parseCanvasAgentApplyRequest,
  parseCanvasAgentConfirmRequest,
  parseCanvasAgentMessageRequest,
  parseCanvasNode,
  parseCanvasOp,
  parseCanvasOps,
  parseCanvasParameters,
  parseCanvasScene,
  parseCreateCanvasRequest,
  parseUpdateCanvasAgentSettingsRequest,
  parseUpdateCanvasRequest,
  type CanvasNode,
  type CanvasOp,
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
    assert.equal(parseCanvasAgentMessageRequest({ kind: 'user', messageId: id(1), text: value, baseRevision: 1 }).success, false)
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

test('strict op parser covers all operations and rejects malformed/unknown fields', () => {
  const examples: CanvasOp[] = [
    { type: 'add_node', node: note(1) },
    { type: 'update_node', nodeId: id(1), patch: { position: { x: 1, y: 2 }, size: { width: 1, height: 2 }, data: { text: 'x' } } },
    { type: 'remove_node', nodeId: id(1) },
    { type: 'connect', edge: { id: id(2), source: id(1), target: id(3) } },
    { type: 'disconnect', edgeId: id(2) },
    { type: 'arrange', positions: [{ nodeId: id(1), position: { x: 10, y: 0 } }] },
  ]
  assert.deepEqual(valid(parseCanvasOps(examples)), examples)
  for (const value of [
    { type: 'unknown' }, { ...examples[0], command: 'x' },
    { type: 'update_node', nodeId: id(1), patch: {} },
    { type: 'update_node', nodeId: id(1), patch: { data: {} } },
    { type: 'update_node', nodeId: id(1), patch: { type: 'video' } },
    { type: 'update_node', nodeId: id(1), patch: { data: { signedUrl: 'x' } } },
    { type: 'remove_node', nodeId: 'bad' },
    { type: 'disconnect', edgeId: 'bad' },
    { type: 'arrange', positions: [] },
    { type: 'arrange', positions: [{ nodeId: id(1), position: { x: 0, y: 0 } }, { nodeId: id(1), position: { x: 1, y: 1 } }] },
  ]) invalid(parseCanvasOp(value))
  valid(parseCanvasOps(Array.from({ length: CANVAS_MAX_OPS }, () => examples[2])))
  invalid(parseCanvasOps(Array.from({ length: CANVAS_MAX_OPS + 1 }, () => examples[2])))
})

test('applyCanvasOps is deterministic, atomic, pure and cleans edges/source references', () => {
  const input = fixture()
  const snapshot = JSON.stringify(input)
  const operations: CanvasOp[] = [
    { type: 'update_node', nodeId: id(1), patch: { data: { prompt: 'dog' } } },
    { type: 'add_node', node: note(5) },
    { type: 'connect', edge: { id: id(22), source: id(3), target: id(5) } },
    { type: 'arrange', positions: [{ nodeId: id(5), position: { x: -10, y: 99 } }] },
    { type: 'disconnect', edgeId: id(20) },
    { type: 'remove_node', nodeId: id(2) },
  ]
  const opSnapshot = JSON.stringify(operations)
  const output = valid(applyCanvasOps(input, operations))
  assert.deepEqual(valid(applyCanvasOps(input, operations)), output)
  assert.equal(JSON.stringify(input), snapshot)
  assert.equal(JSON.stringify(operations), opSnapshot)
  assert.deepEqual(output.nodes.map(node => node.id), [id(1), id(3), id(4), id(5)])
  assert.deepEqual(output.edges, [{ id: id(22), source: id(3), target: id(5) }])
  assert.equal('sourceNodeId' in output.nodes[1]!.data, false)
  assert.equal((output.nodes[0]!.data as { prompt: string }).prompt, 'dog')
  assert.deepEqual(output.nodes[3]!.position, { x: -10, y: 99 })
  const failed = applyCanvasOps(input, [...operations, { type: 'remove_node', nodeId: id(99) }])
  invalid(failed, CanvasErrorCode.CANVAS_NODE_NOT_FOUND)
  assert.equal(JSON.stringify(input), snapshot)
  assert.equal(JSON.stringify(operations), opSnapshot)
  output.nodes[0]!.position.x = 999
  assert.equal(input.nodes[0]!.position.x, 1.5)
  output.nodes[3]!.position.x = 1000
  assert.equal(JSON.stringify(operations), opSnapshot)
})

test('applyCanvasOps validates operations in context and never silently loses edits', () => {
  const input = fixture()
  invalid(applyCanvasOps(input, [{ type: 'add_node', node: note(1) }]), CanvasErrorCode.CANVAS_DUPLICATE_NODE_ID)
  invalid(applyCanvasOps(input, [{ type: 'connect', edge: input.edges[0] }]), CanvasErrorCode.CANVAS_DUPLICATE_EDGE_ID)
  invalid(applyCanvasOps(input, [{ type: 'connect', edge: { id: id(99), source: id(1), target: id(99) } }]), CanvasErrorCode.CANVAS_DANGLING_REFERENCE)
  invalid(applyCanvasOps(input, [{ type: 'disconnect', edgeId: id(99) }]), CanvasErrorCode.CANVAS_EDGE_NOT_FOUND)
  invalid(applyCanvasOps(input, [{ type: 'update_node', nodeId: id(99), patch: { data: { text: 'x' } } }]), CanvasErrorCode.CANVAS_NODE_NOT_FOUND)
  invalid(applyCanvasOps(input, [{ type: 'update_node', nodeId: id(1), patch: { data: { text: 'wrong kind' } } }]))
  invalid(applyCanvasOps(input, [{ type: 'update_node', nodeId: id(2), patch: { data: { sourceNodeId: id(99) } } }]), CanvasErrorCode.CANVAS_DANGLING_REFERENCE)
  invalid(applyCanvasOps(input, [{ type: 'arrange', positions: [{ nodeId: id(99), position: { x: 0, y: 0 } }] }]), CanvasErrorCode.CANVAS_NODE_NOT_FOUND)
  invalid(applyCanvasOps({}, []))
  assert.deepEqual(valid(applyCanvasOps(input, [])), input)
  const full = { nodes: Array.from({ length: CANVAS_MAX_NODES }, (_, i) => note(i)), edges: [] }
  invalid(applyCanvasOps(full, [{ type: 'add_node', node: note(CANVAS_MAX_NODES) }]), CanvasErrorCode.CANVAS_NODE_LIMIT_EXCEEDED)
  const replaced = valid(applyCanvasOps(input, [{ type: 'update_node', nodeId: id(1), patch: { data: { parameters: { temperature: 0.5 } } } }]))
  assert.deepEqual((replaced.nodes[0]!.data as { parameters: unknown }).parameters, { temperature: 0.5 })
  const large = { nodes: Array.from({ length: 10 }, (_, i) => note(i, '猫'.repeat(16_000))), edges: [] }
  const before = JSON.stringify(large)
  invalid(applyCanvasOps(large, [{ type: 'add_node', node: note(100, '猫'.repeat(16_000)) }]), CanvasErrorCode.CANVAS_SCENE_TOO_LARGE)
  assert.equal(JSON.stringify(large), before)
})

test('user message defaults to confirmation; auto events cannot claim server state or override confirmation', () => {
  const user = { kind: 'user', messageId: id(1), text: ' draw cat ', baseRevision: 1 }
  assert.deepEqual(valid(parseCanvasAgentMessageRequest(user)), { ...user, requireConfirmation: true, sceneCommitMode: 'client-managed' })
  assert.deepEqual(valid(parseCanvasAgentMessageRequest({ ...user, requireConfirmation: false })), { ...user, requireConfirmation: false, sceneCommitMode: 'client-managed' })
  const auto = { kind: 'job_event', messageId: id(2), jobId: id(3), baseRevision: 2 }
  assert.deepEqual(valid(parseCanvasAgentMessageRequest(auto)), { ...auto, sceneCommitMode: 'client-managed' })
  assert.deepEqual(valid(parseCanvasAgentMessageRequest({ ...auto, sceneCommitMode: 'agent-managed' })), { ...auto, sceneCommitMode: 'agent-managed' })
  for (const field of ['role', 'status', 'assetId', 'system', 'text', 'requireConfirmation', 'commands']) invalid(parseCanvasAgentMessageRequest({ ...auto, [field]: 'spoof' }))
  for (const value of [{ ...user, text: ' ' }, { ...user, text: 'x'.repeat(CANVAS_MAX_TEXT_LENGTH + 1) }, { ...user, role: 'system' }, { ...user, messageId: 'bad' }, { ...auto, jobId: 'bad' }, { ...user, baseRevision: 0 }, { ...user, requireConfirmation: 'false' }, { ...user, kind: 'assistant' }]) invalid(parseCanvasAgentMessageRequest(value))
})

test('user message parses structured context, inputs, edit source and scene commit mode', () => {
  const base = { kind: 'user' as const, messageId: id(1), text: 'draw', baseRevision: 1 }
  const full = {
    ...base,
    sceneCommitMode: 'agent-managed' as const,
    context: {
      intent: 'generate' as const,
      modelId: id(2),
      parameters: { size: '1024x1024', count: 1 },
      inputs: [{ uploadId: id(3), role: 'reference_image', position: 0 }],
      editSource: { assetId: id(4), selection: { x: 10, y: 20, width: 100, height: 200 } },
    },
  }
  const parsed = valid(parseCanvasAgentMessageRequest(full))
  assert.equal(parsed.kind, 'user')
  if (parsed.kind === 'user') {
    assert.equal(parsed.sceneCommitMode, 'agent-managed')
    assert.equal(parsed.context?.intent, 'generate')
    assert.equal(parsed.context?.modelId, id(2))
    assert.deepEqual(parsed.context?.parameters, { size: '1024x1024', count: 1 })
    assert.deepEqual(parsed.context?.inputs, [{ uploadId: id(3), role: 'reference_image', position: 0 }])
    assert.deepEqual(parsed.context?.editSource, { assetId: id(4), selection: { x: 10, y: 20, width: 100, height: 200 } })
  }

  // Asset input instead of upload input
  const assetCtx = { ...base, context: { inputs: [{ assetId: id(5), role: 'first_frame', position: 0 }] } }
  const parsedAsset = valid(parseCanvasAgentMessageRequest(assetCtx))
  assert.equal(parsedAsset.kind, 'user')
  if (parsedAsset.kind === 'user') {
    assert.deepEqual(parsedAsset.context?.inputs, [{ assetId: id(5), role: 'first_frame', position: 0 }])
  }

  // Edit source with nodeId
  const nodeCtx = { ...base, context: { editSource: { nodeId: id(6), selection: { x: 0, y: 0, width: 50, height: 50 } } } }
  const parsedNode = valid(parseCanvasAgentMessageRequest(nodeCtx))
  assert.equal(parsedNode.kind, 'user')
  if (parsedNode.kind === 'user') {
    assert.deepEqual(parsedNode.context?.editSource, { nodeId: id(6), selection: { x: 0, y: 0, width: 50, height: 50 } })
  }

  // Rejections on invalid context
  invalid(parseCanvasAgentMessageRequest({ ...base, sceneCommitMode: 'invalid' }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { intent: 'invalid' } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { modelId: 'not-uuid' } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { parameters: 'not-obj' } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { unknownField: 1 } }))
  // Invalid inputs
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { inputs: [{ uploadId: id(1), assetId: id(2), role: 'ref', position: 0 }] } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { inputs: [{ role: 'ref', position: 0 }] } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { inputs: [{ uploadId: id(1), role: '', position: 0 }] } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { inputs: [{ uploadId: id(1), role: 'x'.repeat(65), position: 0 }] } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { inputs: [{ uploadId: id(1), role: 'ref', position: -1 }] } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { inputs: [{ uploadId: id(1), role: 'ref', position: 16 }] } }))
  // Invalid edit source
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { editSource: { selection: { x: 0, y: 0, width: 10, height: 10 } } } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { editSource: { assetId: id(1), selection: { x: -1, y: 0, width: 10, height: 10 } } } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { editSource: { assetId: id(1), selection: { x: 0, y: 0, width: 0, height: 10 } } } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { editSource: { assetId: id(1), selection: { x: 0, y: 0, width: 10, height: -5 } } } }))
  invalid(parseCanvasAgentMessageRequest({ ...base, context: { editSource: { assetId: id(1), selection: { x: NaN, y: 0, width: 10, height: 10 } } } }))
})

test('apply request only accepts a valid turn ID', () => {
  assert.deepEqual(valid(parseCanvasAgentApplyRequest({ turnId: id(1) })), { turnId: id(1) })
  invalid(parseCanvasAgentApplyRequest({ turnId: 'bad' }))
  invalid(parseCanvasAgentApplyRequest({ turnId: id(1), extra: true }))
  invalid(parseCanvasAgentApplyRequest({}))
  invalid(parseCanvasAgentApplyRequest(null))
})

test('confirm request only accepts the pending ID and approval decision', () => {
  assert.deepEqual(valid(parseCanvasAgentConfirmRequest({ pendingId: id(1), approve: false })), { pendingId: id(1), approve: false })
  valid(parseCanvasAgentConfirmRequest({ pendingId: id(1), approve: true }))
  for (const value of [{ pendingId: 'bad', approve: true }, { pendingId: id(1), approve: 'true' }, { pendingId: id(1), approve: true, commands: [] }, { pendingId: id(1), approve: true, prompt: 'changed' }]) invalid(parseCanvasAgentConfirmRequest(value))
})

test('settings partial updates are strict, bounded and do not reset omitted fields', () => {
  assert.deepEqual(CANVAS_AGENT_SETTINGS_DEFAULTS, { enabled: false, languageModelConfigId: null, maxToolCallsPerTurn: 12, maxJobsPerTurn: 4, timeoutMs: 120000, maxAutoContinuations: 3 })
  assert.deepEqual(valid(parseUpdateCanvasAgentSettingsRequest({ enabled: true })), { enabled: true })
  valid(parseUpdateCanvasAgentSettingsRequest({ languageModelConfigId: null }))
  valid(parseUpdateCanvasAgentSettingsRequest({ languageModelConfigId: id(1) }))
  for (const [key, min, max] of [['maxToolCallsPerTurn', 1, 32], ['maxJobsPerTurn', 1, 8], ['timeoutMs', 1000, 300000], ['maxAutoContinuations', 0, 10]] as const) {
    valid(parseUpdateCanvasAgentSettingsRequest({ [key]: min }))
    valid(parseUpdateCanvasAgentSettingsRequest({ [key]: max }))
    for (const value of [min - 1, max + 1, min + 0.5, String(min), null, Infinity]) invalid(parseUpdateCanvasAgentSettingsRequest({ [key]: value }))
  }
  for (const value of [{}, { enabled: 1 }, { languageModelConfigId: 'bad' }, { updatedAt: 'x' }, { maxJobsPerTurn: undefined }, JSON.parse('{"__proto__":{}}')]) invalid(parseUpdateCanvasAgentSettingsRequest(value))
})

test('prepared edit metadata preserves clamped original pixels and rejects unsafe/out-of-bounds summaries', () => {
  const valid = { selection: { x: 2, y: 3, width: 4, height: 5 }, sourceWidth: 10, sourceHeight: 12 }
  assert.deepEqual(parseCanvasAgentEditMetadata(valid), { success: true, data: valid })
  for (const changed of [{ ...valid, sourceWidth: 1 }, { ...valid, sourceHeight: 0 }, { ...valid, sourceWidth: 12.5 }, { ...valid, selection: { ...valid.selection, x: -1 } }, { ...valid, credential: 'not-allowed' }]) assert.equal(parseCanvasAgentEditMetadata(changed).success, false)
})
