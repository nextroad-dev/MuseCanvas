import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { db } from '@musecanvas/database'
import type { AuthedContext } from './router/types'
import { listLibrary } from './modules/library/handlers'
import { invalidateRuntimeSettings } from './modules/settings/runtime'
import { decodeCursor } from './shared/pagination'

const ACTOR_ID = '33333333-3333-4333-8333-333333333333'
const CURSOR_ID = '44444444-4444-4444-8444-444444444444'
const CURSOR_DATE = '2026-01-02T03:04:05.000Z'

type QueryCall = { sql: string; values: unknown[] }

async function captureLibraryQueries(search: string): Promise<QueryCall[]> {
  const pool = db()
  const originalQuery = pool.query
  const calls: QueryCall[] = []
  pool.query = (async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values: [...values] })
    return { rows: sql.startsWith('SELECT count(*)') ? [{ total: 0 }] : [] }
  }) as unknown as typeof pool.query

  try {
    const context = {
      actor: { id: ACTOR_ID, role: 'user' },
      request: { nextUrl: new URL(`http://localhost/api/library${search}`) },
    } as unknown as AuthedContext
    const response = await listLibrary(context)
    assert.equal(response.status, 200)
  } finally {
    pool.query = originalQuery
  }

  return calls
}

test('library first-page count query excludes the page limit parameter', async () => {
  const calls = await captureLibraryQueries('?limit=30')

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].values, [ACTOR_ID, 31])
  assert.deepEqual(calls[1].values, [ACTOR_ID])
  assert.match(calls[0].sql, /LIMIT \$2/)
  assert.ok(calls[0].sql.includes(`to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at`))
  assert.doesNotMatch(calls[1].sql, /LIMIT/)
})

test('library count query excludes the cursor and page limit parameters', async () => {
  const cursor = Buffer.from(JSON.stringify({ createdAt: CURSOR_DATE, id: CURSOR_ID })).toString('base64url')
  const calls = await captureLibraryQueries(`?limit=30&cursor=${encodeURIComponent(cursor)}`)

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].values, [ACTOR_ID, CURSOR_DATE, CURSOR_ID, 31])
  assert.deepEqual(calls[1].values, [ACTOR_ID])
  assert.match(calls[0].sql, /\(a\.created_at,a\.id\)<\(\$2::timestamptz,\$3::uuid\)/)
  assert.match(calls[0].sql, /LIMIT \$4/)
  assert.doesNotMatch(calls[1].sql, /a\.created_at,a\.id/)
})

test('library nonempty pages preserve microseconds and tied rows through DTO signing', async () => {
  const environment = {
    S3_ENDPOINT: 'https://storage.example.invalid',
    S3_PUBLIC_ENDPOINT: 'https://media.example.invalid',
    S3_REGION: 'fixture',
    S3_BUCKET: 'fixture',
    S3_ACCESS_KEY_ID: 'fixture-access-key',
    S3_SECRET_ACCESS_KEY: 'fixture-secret-key',
    S3_SIGNED_URL_TTL: '900',
  }
  const saved = new Map(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  const rows = ['123999', '123456', '123456', '123456', '123455', '123000'].map((fraction, index) => ({
    id: `44444444-4444-4444-8444-${String(9 - index).padStart(12, '0')}`,
    created_at: new Date(`2026-10-18T00:00:00.${fraction}Z`),
    cursor_created_at: `2026-10-18T00:00:00.${fraction}Z`,
    object_key: `private/fixture-${index}.png`, mime_type: 'image/png', media_kind: 'image',
    width: 120, height: 80, size_bytes: 42,
  }))
  const pageQueries: QueryCall[] = []
  const countQueries: QueryCall[] = []
  const query = mock.method(db(), 'query', async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('SELECT config_revision')) return { rows: [{ config_revision: 1 }] }
    if (sql.startsWith('SELECT count(*)')) {
      countQueries.push({ sql, values: [...values] })
      return { rows: [{ total: rows.length }] }
    }
    if (!sql.startsWith('SELECT a.id')) return { rows: [] }
    pageQueries.push({ sql, values: [...values] })
    assert.equal(values[0], ACTOR_ID)
    assert.ok(sql.includes(`to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at`))
    assert.match(sql, /ORDER BY a\.created_at DESC,a\.id DESC/)
    const hasCursor = values.length === 4
    if (hasCursor) assert.match(sql, /\(a\.created_at,a\.id\)<\(\$2::timestamptz,\$3::uuid\)/)
    // Fixed-width UTC strings retain the PostgreSQL tuple boundary. All pool
    // queries are mocked; signing uses synthetic credentials and no network I/O.
    return { rows: rows.filter(row => !hasCursor || row.cursor_created_at < (values[1] as string)
      || (row.cursor_created_at === values[1] && row.id < (values[2] as string)))
      .slice(0, values.at(-1) as number) }
  })
  invalidateRuntimeSettings()
  try {
    const ids: string[] = []
    const cursors: Array<ReturnType<typeof decodeCursor>> = []
    let cursor: string | undefined
    let pageCount = 0
    do {
      const params = new URLSearchParams({ limit: '2', ...(cursor ? { cursor } : {}) })
      const response = await listLibrary({
        actor: { id: ACTOR_ID, role: 'user' },
        request: { nextUrl: new URL(`http://localhost/api/library?${params}`) },
      } as unknown as AuthedContext)
      const payload = await response.json()
      assert.equal(response.status, 200)
      assert.equal(payload.data.total, rows.length)
      for (const item of payload.data.items) {
        const row = rows.find(candidate => candidate.id === item.id)!
        ids.push(item.id)
        assert.equal(item.createdAt, '2026-10-18T00:00:00.123Z')
        assert.equal('cursor_created_at' in item, false)
        assert.equal(item.url, item.downloadUrl)
        assert.equal(item.url, item.imageUrl)
        const signed = new URL(item.url)
        assert.equal(signed.hostname, 'media.example.invalid')
        assert.equal(signed.pathname, `/fixture/${row.object_key}`)
        assert.ok(signed.searchParams.has('X-Amz-Signature'))
      }
      cursor = payload.data.nextCursor
      if (cursor) cursors.push(decodeCursor(cursor))
      assert.equal(payload.data.hasMore, !!cursor)
      assert.ok(++pageCount <= 3, 'pagination must make progress')
    } while (cursor)
    assert.deepEqual(ids, rows.map(row => row.id))
    assert.deepEqual(cursors, [1, 3].map(index => ({ createdAt: rows[index].cursor_created_at, id: rows[index].id })))
    assert.deepEqual(pageQueries.map(call => call.values), [
      [ACTOR_ID, 3],
      [ACTOR_ID, rows[1].cursor_created_at, rows[1].id, 3],
      [ACTOR_ID, rows[3].cursor_created_at, rows[3].id, 3],
    ])
    assert.deepEqual(countQueries.map(call => call.values), [[ACTOR_ID], [ACTOR_ID], [ACTOR_ID]])
  } finally {
    query.mock.restore()
    invalidateRuntimeSettings()
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
