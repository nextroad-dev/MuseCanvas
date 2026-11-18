import assert from 'node:assert/strict'
import test from 'node:test'
import type { JsonObject, ToolExecutionResult } from '@musecanvas/contracts'
import { createReadonlyAgentTools, createReadonlyToolRegistry, readonlyTools } from './readonly'
import type { AgentSqlClient, AgentToolContext } from '../ports'
import { MAX_TOOL_OUTPUT_BYTES, ToolValidationError, type ToolContext, type ToolQuery } from './registry'

const ownerId = '11111111-1111-4111-8111-111111111111'
const foreignOwner = '22222222-2222-4222-8222-222222222222'
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`
const createdAt = '2026-11-17T12:00:00.123456Z'
type Row = Record<string, unknown>
type Step = (sql: string, values: unknown[]) => Row[]
function fakeQuery(steps: Step[]): ToolQuery & { remaining(): number } {
  let index = 0
  return { async query<Row extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
    assert.ok(index < steps.length, `Unexpected query: ${sql}`)
    return { rows: steps[index++](sql, values) as Row[] }
  }, remaining: () => steps.length - index }
}
function ctx(query: ToolQuery, extra: Partial<ToolContext> = {}): ToolContext { return { ownerId, query, ...extra } }
async function invoke(context: ToolContext, name: string, args: JsonObject = {}): Promise<ToolExecutionResult> {
  const registry = createReadonlyToolRegistry()
  return registry.dispatch(context, registry.validate(name, 1, args))
}
function result(outcome: ToolExecutionResult): JsonObject {
  assert.equal(outcome.kind, 'completed')
  if (outcome.kind !== 'completed') throw new Error('Expected completed result')
  assert.ok(Buffer.byteLength(JSON.stringify(outcome), 'utf8') <= MAX_TOOL_OUTPUT_BYTES)
  return outcome.result
}
function asset(n: number, overrides: Row = {}): Row {
  return { id: id(n), media_kind: 'image', mime_type: 'image/png', width: 1024, height: 768, duration_seconds: null, fps: null, has_audio: false,
    size_bytes: '4567', cursor_created_at: createdAt, prompt: 'hidden prompt', metadata: { token: 'secret' }, object_key: 'private/path',
    url: 'https://private.invalid/file?signature=secret', credential: 'secret', ...overrides }
}
function assertReadyPredicate(sql: string): void {
  assert.match(sql, /a\.created_by=\$1/)
  assert.match(sql, /j\.created_by=\$1/)
  assert.match(sql, /a\.deleted_at IS NULL/)
  assert.match(sql, /j\.deleted_at IS NULL/)
  assert.match(sql, /j\.status='succeeded'/)
  assert.match(sql, /JOIN generation_jobs j ON j\.id=a\.job_id/)
  assert.doesNotMatch(sql, /SELECT (?:a\.)?\*|object_key|metadata|final_prompt|base_url|payload_encrypted/)
}

test('search_assets scopes owner and ready resources, escapes literal search and emits exact keyset continuation', async () => {
  const rows = [asset(4), asset(3), asset(2)]
  const query = fakeQuery([
    (sql, values) => {
      assertReadyPredicate(sql)
      assert.match(sql, /a\.prompt ILIKE \$3 ESCAPE/)
      assert.match(sql, /ORDER BY a\.created_at DESC,a\.id DESC LIMIT \$2/)
      assert.match(sql, /\(a\.created_at,a\.id\)<\(\$5::timestamptz,\$6::uuid\)/)
      assert.deepEqual(values, [ownerId, 3, '%cat\\%\\_\\\\%', 'image', null, null])
      return rows
    },
    (sql, values) => {
      assertReadyPredicate(sql)
      assert.deepEqual(values, [ownerId, 3, '%cat\\%\\_\\\\%', 'image', createdAt, id(3)])
      return [asset(2), asset(1)]
    },
  ])
  const first = result(await invoke(ctx(query), 'search_assets', { query: ' cat%_\\ ', mediaKind: 'image', limit: 2 }))
  assert.deepEqual((first.items as JsonObject[]).map(item => item.id), [id(4), id(3)])
  assert.equal(first.hasMore, true)
  const nextCursor = first.nextCursor as string
  assert.deepEqual(JSON.parse(Buffer.from(nextCursor, 'base64url').toString()), { createdAt, id: id(3) })
  const second = result(await invoke(ctx(query), 'search_assets', { query: ' cat%_\\ ', mediaKind: 'image', limit: 2, cursor: nextCursor }))
  assert.deepEqual((second.items as JsonObject[]).map(item => item.id), [id(2), id(1)])
  assert.equal(second.hasMore, false)
  assert.equal(second.nextCursor, null)
  assert.equal(query.remaining(), 0)
  assert.doesNotMatch(JSON.stringify(first), /secret|https:|private\/|hidden prompt|metadata|credential|object_key/)
})

test('search_assets exact limit edges, default, empty results and all filters stay bounded', async () => {
  for (const limit of [1, 50]) {
    const query = fakeQuery([(sql, values) => {
      assertReadyPredicate(sql)
      assert.deepEqual(values, [ownerId, limit + 1, null, null, null, null])
      return Array.from({ length: limit + 1 }, (_, n) => asset(100 - n))
    }])
    const page = result(await invoke(ctx(query), 'search_assets', { limit }))
    assert.equal((page.items as JsonObject[]).length, limit)
    assert.equal(page.hasMore, true)
    assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor as string, 'base64url').toString()), { createdAt, id: id(101 - limit) })
  }
  const query = fakeQuery([(sql, values) => { assertReadyPredicate(sql); assert.deepEqual(values, [ownerId, 21, null, null, null, null]); return [] }])
  assert.deepEqual(result(await invoke(ctx(query), 'search_assets')), { items: [], hasMore: false, nextCursor: null })
})

test('search_assets rejects malformed and impossible cursors before any query', async () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const valid = { createdAt, id: id(1) }
  const cursors = ['', 'abc=', 'a', encode(null), encode([]), encode({ ...valid, extra: true }), encode({ ...valid, id: 'invalid' }),
    encode({ ...valid, createdAt: '2026-11-17T12:00:00.123Z' }), encode({ ...valid, createdAt: '2026-02-30T12:00:00.123456Z' }),
    encode({ ...valid, createdAt: '0000-11-17T12:00:00.123456Z' }), encode({ ...valid, createdAt: '2026-11-17T12:00:00.123456+01:00' })]
  const query = fakeQuery([])
  for (const cursor of cursors) await assert.rejects(invoke(ctx(query), 'search_assets', { cursor }), error => error instanceof ToolValidationError && error.code === 'INVALID_ARGUMENTS')
  assert.equal(query.remaining(), 0)
})

test('get_asset filters foreign/deleted/unready rows and projects only ready metadata with no URLs', async () => {
  const fixtures = [asset(1, { created_by: ownerId, job_owner: ownerId, deleted_at: null, job_deleted_at: null, status: 'succeeded' }),
    asset(2, { created_by: foreignOwner, job_owner: foreignOwner, status: 'succeeded' }),
    asset(3, { created_by: ownerId, job_owner: foreignOwner, status: 'succeeded' }),
    asset(4, { created_by: ownerId, job_owner: ownerId, deleted_at: createdAt, status: 'succeeded' }),
    asset(5, { created_by: ownerId, job_owner: ownerId, job_deleted_at: createdAt, status: 'succeeded' }),
    asset(6, { created_by: ownerId, job_owner: ownerId, status: 'running' })]
  const steps = fixtures.map(() => (sql: string, values: unknown[]) => {
    assertReadyPredicate(sql)
    assert.match(sql, /a\.id=\$2::uuid LIMIT 1/)
    assert.equal(values[0], ownerId)
    return fixtures.filter(row => row.id === values[1] && row.created_by === values[0] && row.job_owner === values[0]
      && !row.deleted_at && !row.job_deleted_at && row.status === 'succeeded')
  })
  const query = fakeQuery(steps)
  const visible = result(await invoke(ctx(query), 'get_asset', { assetId: id(1) })).asset as JsonObject
  assert.deepEqual(visible, { id: id(1), mediaKind: 'image', mimeType: 'image/png', width: 1024, height: 768, durationSeconds: null, fps: null, hasAudio: false, sizeBytes: 4567, createdAt })
  const hidden = await Promise.all(fixtures.slice(1).map(row => invoke(ctx(query), 'get_asset', { assetId: row.id as string })))
  assert.ok(hidden.every(outcome => outcome.kind === 'failed'))
  for (const outcome of hidden) assert.deepEqual(outcome, hidden[0])
})

test('asset metadata normalizes numeric PG strings and refuses unsafe numeric payloads', async () => {
  const query = fakeQuery([() => [asset(1, { media_kind: 'video', mime_type: 'video/mp4', duration_seconds: '1.25', fps: '24', width: Infinity, height: '-2', size_bytes: '9007199254740992', has_audio: true })]])
  const dto = result(await invoke(ctx(query), 'get_asset', { assetId: id(1) })).asset as JsonObject
  assert.equal(dto.durationSeconds, 1.25)
  assert.equal(dto.fps, 24)
  assert.equal(dto.width, null)
  assert.equal(dto.height, null)
  assert.equal(dto.sizeBytes, null)
})

test('list_models selects active credential-backed declared revisions and whitelists capabilities', async () => {
  const query = fakeQuery([(sql, values) => {
    assert.match(sql, /rev\.id=m\.latest_revision_id AND rev\.model_id=m\.id/)
    assert.match(sql, /pc\.id=rev\.credential_id AND pc\.enabled=true AND pc\.deleted_at IS NULL/)
    assert.match(sql, /m\.enabled=true AND m\.deleted_at IS NULL/)
    assert.match(sql, /m\.model_kind IN \('image','video'\)/)
    assert.match(sql, /declaredBy' IN \('plugin-manifest','host-synthesized'\)/)
    assert.match(sql, /jsonb_typeof\(rev\.capabilities->'modes'\)='array'/)
    assert.match(sql, /COALESCE\(NULLIF\(pc\.payload_encrypted,''\),NULLIF\(pc\.api_key_encrypted,''\)\) IS NOT NULL/)
    assert.doesNotMatch(sql.split('FROM')[0], /\*|base_url|credential|normalized_config|defaults/)
    assert.deepEqual(values, ['text_to_image', 51])
    return [{ id: id(1), display_name: 'Model https://private.invalid/?key=secret', model_kind: 'image', revision_id: id(2), revision: 3,
      modes: ['text_to_image', 'text_to_video', 'sql'], max_count: 4, base_url: 'https://secret', api_key: 'credential', defaults: { token: 'hidden' } },
    { id: id(3), display_name: 'Unknown', model_kind: 'image', revision_id: id(4), revision: 1, modes: ['unknown'] }]
  }])
  const output = result(await invoke(ctx(query), 'list_models', { mode: 'text_to_image' }))
  assert.deepEqual(output, { items: [{ id: id(1), displayName: 'Model [redacted]', modelKind: 'image', revisionId: id(2), revision: 3,
    modes: ['text_to_image'], maxCount: 4, estimatedCost: null }], truncated: false })
  assert.doesNotMatch(JSON.stringify(output), /secret|credential|hidden|base_url|defaults|https:/)
})

test('list_models uses UTF8 output bytes including the result envelope and marks truncation', async () => {
  const rows = Array.from({ length: 101 }, (_, n) => ({ id: id(n + 1), display_name: '中'.repeat(120), model_kind: 'image', revision_id: id(n + 200),
    revision: 1, modes: ['text_to_image'], max_count: 1 }))
  const query = fakeQuery([(_sql, values) => { assert.deepEqual(values, [null, 101]); return rows }])
  const output = result(await invoke(ctx(query), 'list_models', { limit: 100 }))
  assert.equal(output.truncated, true)
  assert.ok((output.items as JsonObject[]).length > 0)
  assert.ok((output.items as JsonObject[]).length < 100)
  assert.ok(Buffer.byteLength(JSON.stringify(output), 'utf8') > JSON.stringify(output).length)
})

function canvasScene() {
  return { nodes: [
    { id: id(10), type: 'note', position: { x: 1, y: 2 }, data: { text: 'credential https://signed.invalid/?token=secret' } },
    { id: id(11), type: 'image', position: { x: 3, y: 4 }, size: { width: 100, height: 200 }, data: { assetId: id(1), prompt: 'private', parameters: { baseURL: 'https://private.invalid', credential: 'hidden' } } },
    { id: id(12), type: 'video', position: { x: 5, y: 6 }, data: { assetId: id(2) } },
    { id: id(13), type: 'image', position: { x: 7, y: 8 }, data: { assetId: id(3) } },
  ], edges: [{ id: id(20), source: id(10), target: id(11) }, { id: id(21), source: id(11), target: id(12) }] }
}
function canvasStep(sql: string, values: unknown[]): Row[] {
  assert.match(sql, /WHERE id=\$1 AND created_by=\$2 AND deleted_at IS NULL LIMIT 1/)
  assert.deepEqual(values, [id(100), ownerId])
  assert.doesNotMatch(sql, /SELECT \*/)
  return [{ id: id(100), revision: 4, scene: canvasScene() }]
}

test('get_canvas bounds structure and checks owner/readiness for each exposed media reference', async () => {
  const query = fakeQuery([canvasStep, (sql, values) => {
    assertReadyPredicate(sql)
    assert.match(sql, /a\.id=ANY\(\$2::uuid\[\]\) LIMIT 50/)
    assert.deepEqual(values, [ownerId, [id(1), id(2), id(3)]])
    // id(2) is foreign; id(3) exists but has the wrong media kind.
    return [{ id: id(1), media_kind: 'image' }, { id: id(3), media_kind: 'video' }]
  }])
  const output = result(await invoke(ctx(query, { canvasId: id(100) }), 'get_canvas'))
  const nodes = output.nodes as JsonObject[]
  assert.equal(output.canvasId, id(100))
  assert.equal(output.revision, 4)
  assert.equal(output.nodeCount, 4)
  assert.equal(output.edgeCount, 2)
  assert.equal(output.truncated, false)
  assert.equal(nodes[1].assetId, id(1))
  assert.equal(nodes[2].assetId, undefined)
  assert.equal(nodes[3].assetId, undefined)
  assert.doesNotMatch(JSON.stringify(output), /secret|private|hidden|https:|credential|parameters|prompt|text|baseURL/)
})

test('get_canvas explicit selection and limits return only edges whose endpoints are visible', async () => {
  const query = fakeQuery([canvasStep, () => [{ id: id(1), media_kind: 'image' }], canvasStep])
  const output = result(await invoke(ctx(query), 'get_canvas', { canvasId: id(100), nodeIds: [id(10), id(11)], nodeLimit: 2, edgeLimit: 1 }))
  assert.deepEqual((output.nodes as JsonObject[]).map(node => node.id), [id(10), id(11)])
  assert.deepEqual(output.edges, [{ id: id(20), source: id(10), target: id(11) }])
  assert.equal(output.truncated, true)
  const one = result(await invoke(ctx(query), 'get_canvas', { canvasId: id(100), nodeLimit: 1 }))
  assert.deepEqual(one.edges, [])
  assert.equal((one.nodes as JsonObject[]).length, 1)
})

test('get_canvas has identical missing/foreign behavior and rejects missing default context', async () => {
  const query = fakeQuery([(sql, values) => { assert.match(sql, /created_by=\$2/); assert.deepEqual(values, [id(100), ownerId]); return [] }])
  assert.deepEqual(await invoke(ctx(query), 'get_canvas', { canvasId: id(100) }), { kind: 'failed', error: { code: 'TOOL_FAILED', message: 'Resource unavailable', retryable: false } })
  await assert.rejects(invoke(ctx(query), 'get_canvas'), error => error instanceof ToolValidationError && error.code === 'INVALID_ARGUMENTS')
})

test('readonly definitions are fresh copies and importing/installing does not query or use transport', () => {
  const first = readonlyTools()
  first[0].parameters.properties!.injected = { type: 'boolean' }
  assert.equal(readonlyTools()[0].parameters.properties!.injected, undefined)
  const registry = createReadonlyToolRegistry()
  assert.equal(registry.listModelTools().length, 4)
})

function sharedContext(sql: AgentSqlClient): AgentToolContext {
  return { scope: { ownerId, sessionId: id(90), turnId: id(91) },
    turn: { id: id(91), sessionId: id(90), status: 'running', engineVersion: 'test', revision: '1', inputRevision: '1',
      cancelRequestedAt: null, terminalAt: null, deadlineAt: '2026-11-18T00:00:00.000Z', error: null },
    round: { roundId: id(92), position: 0, inputRevision: '1' }, toolCallId: id(93), sql,
    budget: { async reserve() { throw new Error('Read-only tools must not reserve media budget') } }, signal: new AbortController().signal }
}
function sharedSql(steps: Step[]): AgentSqlClient {
  let index = 0
  const sql: AgentSqlClient = { async query(text, params = []) {
    assert.equal(this, sql)
    assert.match(text, /^SELECT /)
    assert.ok(index < steps.length)
    const rows = steps[index++](text, params)
    return { rows, rowCount: rows.length }
  } }
  return sql
}

test('createReadonlyAgentTools uses the caller-owned shared SQL and owner without changing transaction or budget', async () => {
  const sql = sharedSql([(text, values) => {
    assertReadyPredicate(text)
    assert.deepEqual(values, [ownerId, id(1)])
    return [asset(1)]
  }])
  const tools = createReadonlyAgentTools({ allowlist: ['get_asset@v1'] })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].approval, 'never')
  assert.deepEqual(tools[0].budget, { maxMediaJobs: 0, maxMediaOutputs: 0, maxEstimatedCost: null })
  const tool = tools[0]
  tool.parameters.additionalProperties = true
  await assert.rejects(tool.execute(sharedContext(sql), { assetId: id(1), ownerId: foreignOwner }), ToolValidationError)
  const output = result(await tool.execute(sharedContext(sql), { assetId: id(1) }))
  assert.equal((output.asset as JsonObject).id, id(1))
  assert.doesNotMatch(JSON.stringify(output), /secret|credential|hidden|object_key|https:/)
})

test('shared SQL decoder fails closed for malformed rows rather than asserting arbitrary records are typed', async () => {
  const malformed = [asset(1, { id: 'not-uuid' }), asset(1, { media_kind: 'file' }), asset(1, { width: {} }),
    asset(1, { cursor_created_at: 'bad' }), asset(1, { has_audio: 'yes' }), { id: id(1) }]
  const tool = createReadonlyAgentTools({ allowlist: ['get_asset@v1'] })[0]
  for (const row of malformed) {
    const output = await tool.execute(sharedContext(sharedSql([() => [row]])), { assetId: id(1) })
    assert.deepEqual(output, { kind: 'failed', error: { code: 'TOOL_FAILED', message: 'Tool execution failed', retryable: false } })
  }
})

test('shared read-only wrappers delegate model, pagination and canvas queries through checked row decoding', async () => {
  const tools = createReadonlyAgentTools()
  const sql = sharedSql([
    (_text, values) => { assert.deepEqual(values, [null, 51]); return [{ id: id(1), display_name: 'Model', model_kind: 'image', revision_id: id(2), revision: 1, modes: ['text_to_image'], max_count: 1 }] },
    (text, values) => { assertReadyPredicate(text); assert.deepEqual(values, [ownerId, 2, null, null, null, null]); return [asset(2), asset(1)] },
    canvasStep,
    (text, values) => { assertReadyPredicate(text); assert.deepEqual(values, [ownerId, [id(1), id(2), id(3)]]); return [{ id: id(1), media_kind: 'image' }] },
  ])
  const context = sharedContext(sql)
  const models = result(await tools.find(tool => tool.name === 'list_models')!.execute(context, {}))
  assert.equal((models.items as JsonObject[])[0].revisionId, id(2))
  const page = result(await tools.find(tool => tool.name === 'search_assets')!.execute(context, { limit: 1 }))
  assert.equal(page.hasMore, true)
  assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor as string, 'base64url').toString()), { createdAt, id: id(2) })
  const canvas = tools.find(tool => tool.name === 'get_canvas')!
  assert.deepEqual(canvas.parameters.required, ['canvasId'])
  await assert.rejects(canvas.execute(context, {}), error => error instanceof ToolValidationError && error.code === 'INVALID_ARGUMENTS')
  const output = result(await canvas.execute(context, { canvasId: id(100) }))
  assert.equal((output.nodes as JsonObject[])[1].assetId, id(1))
  assert.equal((output.nodes as JsonObject[])[2].assetId, undefined)
})

test('shared model, canvas and media reference row decoders reject invalid database shapes', async () => {
  const tools = createReadonlyAgentTools()
  const model = tools.find(tool => tool.name === 'list_models')!
  assert.equal((await model.execute(sharedContext(sharedSql([() => [{ id: id(1), display_name: {}, model_kind: 'image', revision_id: id(2), revision: 1 }]])), {})).kind, 'failed')
  const canvas = tools.find(tool => tool.name === 'get_canvas')!
  assert.equal((await canvas.execute(sharedContext(sharedSql([() => [{ id: id(100), revision: '1', scene: canvasScene() }]])), { canvasId: id(100) })).kind, 'failed')
  assert.equal((await canvas.execute(sharedContext(sharedSql([canvasStep, () => [{ id: id(1), media_kind: 'file' }]])), { canvasId: id(100) })).kind, 'failed')
})

test('get_canvas uppercase UUID selection returns the same canonical nodes and edges', async () => {
  const ready = () => [{ id: id(1), media_kind: 'image' }]
  const query = fakeQuery([canvasStep, ready, canvasStep, ready])
  const selection = [id(10), id(11)]
  const lower = result(await invoke(ctx(query), 'get_canvas', { canvasId: id(100), nodeIds: selection }))
  const upper = result(await invoke(ctx(query), 'get_canvas', { canvasId: id(100), nodeIds: selection.map(nodeId => nodeId.toUpperCase()) }))
  assert.deepEqual((lower.nodes as JsonObject[]).map(node => node.id), selection)
  assert.deepEqual(lower.edges, [{ id: id(20), source: id(10), target: id(11) }])
  assert.deepEqual(upper, lower)
  assert.equal(query.remaining(), 0)
})
