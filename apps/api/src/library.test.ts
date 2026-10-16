import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@musecanvas/database'
import type { AuthedContext } from './router/types'
import { listLibrary } from './modules/library/handlers'

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
