import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { parseArgs, runBackfill } from '../../scripts/backfill-asset-thumbnails'

type Dependencies = Parameters<typeof runBackfill>[1]
type Row = {
  id: string
  object_key: string
  mime_type: string | null
  media_kind: string | null
  cursor_created_at: string
  thumbnail_state: 'none' | 'failed' | 'ready'
  thumbnail_object_key: string | null
  deleted_at: string | null
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const row = (n: number, overrides: Partial<Row> = {}): Row => ({
  id: id(n), object_key: `source-${n}`, mime_type: 'image/png', media_kind: 'image',
  cursor_created_at: '2026-10-25T12:00:00.000124Z',
  thumbnail_state: 'none', thumbnail_object_key: null, deleted_at: null, ...overrides,
})
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

function fixture(t: TestContext, rows: Row[], fail: (key: string) => boolean = () => false) {
  for (const method of ['log', 'warn', 'error'] as const) t.mock.method(console, method, () => {})
  const selected: string[][] = []
  const derived: string[] = []
  const uploads: string[] = []
  const updates: { sql: string; values: unknown[] }[] = []
  const calls: { sql: string; values: unknown[] }[] = []
  const deps: Dependencies = {
    database: {
      async query(sql, values) {
        calls.push({ sql, values })
        if (sql.startsWith('SELECT')) {
          assert.match(sql, /a\.deleted_at IS NULL/)
          assert.match(sql, /a\.thumbnail_object_key IS NULL/)
          assert.match(sql, /a\.thumbnail_state IN \('none','failed'\)/)
          assert.match(sql, /to_char\(a\.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'\) AS cursor_created_at/)
          assert.match(sql, /ORDER BY a\.created_at DESC, a\.id DESC LIMIT \$\d+$/)
          let index = 0
          const kind = sql.includes('a.media_kind =') ? values[index++] : 'all'
          const hasCursor = sql.includes('(a.created_at, a.id) <')
          if (hasCursor) assert.match(sql, /\(a\.created_at, a\.id\) < \(\$\d+::timestamptz, \$\d+::uuid\)/)
          const time = hasCursor ? values[index++] as string : null
          const cursorId = hasCursor ? values[index++] as string : null
          const limit = values[index++] as number
          assert.equal(values.length, index)
          const result = rows.filter(r => !r.deleted_at && !r.thumbnail_object_key && ['none', 'failed'].includes(r.thumbnail_state)
            && (kind === 'all' || r.media_kind === kind)
            && (!time || r.cursor_created_at < time || (r.cursor_created_at === time && r.id < cursorId!)))
            .sort((a, b) => b.cursor_created_at.localeCompare(a.cursor_created_at) || b.id.localeCompare(a.id))
            .slice(0, limit)
          selected.push(result.map(r => r.id))
          return { rows: result }
        }
        updates.push({ sql, values })
        const target = rows.find(r => r.id === values[0])!
        target.thumbnail_state = sql.includes("thumbnail_state='ready'") ? 'ready' : 'failed'
        if (target.thumbnail_state === 'ready') target.thumbnail_object_key = values[1] as string
        return { rows: [] }
      },
    },
    MAX_THUMBNAIL_SOURCE_BYTES: 1024,
    isFfmpegAvailable: () => false,
    getStorageObject: async (key, maxBytes) => {
      assert.equal(maxBytes, 1024)
      return Buffer.from(key)
    },
    buildDerivedPreview: async (_source, key, _mimeType, kind) => {
      derived.push(key)
      if (fail(key)) return { state: 'skipped', reason: 'undecodable' }
      return { state: 'ready', preview: { objectKey: `${key}-${kind}-thumb`, bytes: Buffer.from('preview'), mimeType: 'image/webp', width: 512, height: 256 } }
    },
    putStorageObject: async key => { uploads.push(key) },
  }
  return { deps, selected, derived, uploads, updates, calls }
}

test('bounded sweep passes 500 permanent newer failures, including timestamp ties, and reaches older valid media', async t => {
  const rows = Array.from({ length: 500 }, (_, n) => row(n + 2))
  rows.push(row(1, { cursor_created_at: '2026-10-25T12:00:00.000123Z' }))
  const f = fixture(t, rows, key => key !== 'source-1')
  const cursor = await runBackfill(parseArgs(['--limit=500']), f.deps)
  assert.ok(cursor)
  assert.equal(f.derived.length, 500)
  assert.equal(f.uploads.length, 0)
  assert.equal(rows.filter(r => r.thumbnail_state === 'failed').length, 500)
  assert.deepEqual(JSON.parse(Buffer.from(cursor, 'base64url').toString()), {
    createdAt: '2026-10-25T12:00:00.000124Z', id: id(2), kind: 'all', dryRun: false,
  })
  const end = await runBackfill(parseArgs([`--cursor=${cursor}`, '--limit=500']), f.deps)
  assert.equal(end, null)
  assert.deepEqual(f.selected.map(page => page.length), [500, 1])
  assert.equal(new Set(f.selected.flat()).size, 501)
  assert.equal(f.derived.length, 501)
  assert.deepEqual(f.uploads, ['source-1-image-thumb'])
  assert.equal(rows.at(-1)!.thumbnail_state, 'ready')
  assert.ok(f.calls[501]!.values.includes('2026-10-25T12:00:00.000124Z'))
  // A new sweep retries failures: pagination does not discard retry eligibility.
  await runBackfill(parseArgs(['--limit=500']), f.deps)
  assert.equal(f.selected[2]!.length, 500)
  assert.ok(!f.selected[2]!.includes(id(1)))
})

test('small batches traverse equal timestamps once, including a final empty page', async t => {
  const f = fixture(t, [row(1), row(2), row(3), row(4)], () => true)
  let cursor: string | null = null
  do {
    cursor = await runBackfill(parseArgs(['--limit=2', ...(cursor ? [`--cursor=${cursor}`] : [])]), f.deps)
  } while (cursor)
  assert.deepEqual(f.selected, [[id(4), id(3)], [id(2), id(1)], []])
  assert.equal(f.derived.length, 4)
})

test('dry-run paginates without reading, deriving, uploading or updating, and retains kind selection', async t => {
  const rows = [row(1), row(2, { media_kind: 'video' }), row(3, { media_kind: 'video' }),
    row(4, { media_kind: 'video', deleted_at: 'deleted' }),
    row(5, { media_kind: 'video', thumbnail_object_key: 'existing', thumbnail_state: 'ready' })]
  const before = structuredClone(rows)
  const f = fixture(t, rows)
  f.deps.getStorageObject = async () => { throw new Error('dry run must not read storage') }
  const cursor = await runBackfill(parseArgs(['--dry-run', '--kind=video', '--limit=1']), f.deps)
  assert.ok(cursor)
  await runBackfill(parseArgs(['--dry-run', '--kind=video', '--limit=2', `--cursor=${cursor}`]), f.deps)
  assert.deepEqual(f.selected, [[id(3)], [id(2)]])
  assert.deepEqual(rows, before)
  assert.deepEqual(f.derived, [])
  assert.deepEqual(f.uploads, [])
  assert.deepEqual(f.updates, [])
  assert.equal(f.calls.length, 2)
})

test('image/video modes preserve ready updates, video poster parameters, and row-error retries', async t => {
  const rows = [row(1), row(2, { media_kind: 'video', mime_type: 'video/mp4' }), row(3)]
  const f = fixture(t, rows)
  const getObject = f.deps.getStorageObject
  f.deps.getStorageObject = async (key, limit) => {
    if (key === 'source-3') throw new Error('unreadable')
    return getObject(key, limit)
  }
  await runBackfill(parseArgs(['--kind=image']), f.deps)
  await runBackfill(parseArgs(['--kind=video']), f.deps)
  assert.deepEqual(f.selected, [[id(3), id(1)], [id(2)]])
  assert.deepEqual(f.updates.map(u => u.values), [
    [id(3)], [id(1), 'source-1-image-thumb', 'image/webp', 512, 256, false],
    [id(2), 'source-2-video-thumb', 'image/webp', 512, 256, true],
  ])
  assert.match(f.updates[2]!.sql, /poster_object_key=CASE WHEN \$6::boolean THEN \$2 ELSE poster_object_key END/)
  assert.equal(rows[2]!.thumbnail_state, 'failed')
})

test('CLI validates limits, modes, duplicate/unknown flags and canonical precision-preserving cursors', () => {
  assert.deepEqual(parseArgs([]), { limit: 500, kind: 'all', dryRun: false, cursor: null })
  assert.equal(parseArgs(['--limit=5000']).limit, 5000)
  const value = { createdAt: '2026-10-25T12:00:00.000123Z', id: id(1), kind: 'all', dryRun: false }
  assert.deepEqual(parseArgs([`--cursor=${encode(value)}`]).cursor, value)
  for (const args of [
    ['--limit=0'], ['--limit=-1'], ['--limit=1.5'], ['--limit=5001'], ['--limit=Infinity'], ['--limit=NaN'],
    ['--limit='], ['--limit=1e2'], ['--limit= 2'], ['--kind=other'], ['--kind='], ['--limt=1'], ['--limit'],
    ['--dry-run', '--dry-run'], ['--limit=2', '--limit=3'],
    [`--cursor=${encode(value)}`, '--kind=image'], [`--cursor=${encode(value)}`, '--dry-run'],
  ]) assert.throws(() => parseArgs(args), JSON.stringify(args))
  for (const token of ['', '!', 'a'.repeat(513), 'abcd=', encode(null), encode([]), encode({}),
    encode({ ...value, id: 'not-a-uuid' }), encode({ ...value, extra: true }),
    encode({ ...value, kind: 'other' }), encode({ ...value, dryRun: 'false' }),
    encode({ ...value, createdAt: '2026-02-30T12:00:00.000123Z' }),
    encode({ ...value, createdAt: '2026-10-25T12:00:00.000Z' }),
    encode({ ...value, createdAt: '0000-10-25T12:00:00.000123Z' }),
  ]) assert.throws(() => parseArgs([`--cursor=${token}`]), /Invalid --cursor/)
})
