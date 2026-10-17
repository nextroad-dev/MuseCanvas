import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '@musecanvas/database'
import { listJobs } from '../modules/admin/jobs'
import { listUsers } from '../modules/admin/users'
import type { AuthedContext } from '../router/types'
import { decodeCursor, encodeCursor } from './pagination'

const ACTOR_ID = '33333333-3333-4333-8333-333333333333'
const ROW_ID = '44444444-4444-4444-8444-444444444444'

test('cursor round trip preserves all six PostgreSQL fractional digits', () => {
  const timestamp = '2026-10-18T00:00:00.123456Z'
  assert.equal(new Date(timestamp).toISOString(), '2026-10-18T00:00:00.123Z')
  const cursor = encodeCursor({ cursor_created_at: timestamp, id: ROW_ID })
  assert.deepEqual(decodeCursor(cursor), { createdAt: timestamp, id: ROW_ID })
})

test('legacy millisecond cursors retain their timestamp and ID', () => {
  const legacy = { createdAt: '2026-10-18T00:00:00.123Z', id: ROW_ID }
  assert.deepEqual(decodeCursor(Buffer.from(JSON.stringify(legacy)).toString('base64url')), legacy)
})

for (const [name, handler, alias] of [
  ['admin users', listUsers, 'u'],
  ['admin jobs', listJobs, 'j'],
] as const) {
  test(`${name} pages through microsecond timestamps and tied rows without gaps or repeats`, async () => {
    const rows = ['123999', '123456', '123456', '123456', '123455', '123000'].map((fraction, index) => ({
      id: `44444444-4444-4444-8444-${String(9 - index).padStart(12, '0')}`,
      created_at: new Date(`2026-10-18T00:00:00.${fraction}Z`),
      cursor_created_at: `2026-10-18T00:00:00.${fraction}Z`,
      email: 'fixture@example.invalid', role: 'user', status: 'active',
    }))
    const pool = db()
    const originalQuery = pool.query
    const boundaries: unknown[][] = []
    pool.query = (async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('SELECT count(*)')) {
        assert.deepEqual(values, [])
        return { rows: [{ total: rows.length }] }
      }
      assert.ok(sql.includes(`to_char(${alias}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at`))
      assert.match(sql, new RegExp(`ORDER BY ${alias}\\.created_at DESC,${alias}\\.id DESC`))
      const hasCursor = values.length === 3
      if (hasCursor) {
        boundaries.push(values.slice(0, 2))
        assert.ok(sql.includes(`(${alias}.created_at,${alias}.id)<($1::timestamptz,$2::uuid)`))
      }
      // Fixed-width UTC strings preserve PG tuple ordering without truncating
      // the timestamp through Date. This mock never opens a database connection.
      return { rows: rows.filter(row => !hasCursor || row.cursor_created_at < (values[0] as string)
        || (row.cursor_created_at === values[0] && row.id < (values[1] as string)))
        .slice(0, values.at(-1) as number) }
    }) as unknown as typeof pool.query
    try {
      const ids: string[] = []
      let cursor: string | undefined
      let pageCount = 0
      do {
        const query = new URLSearchParams({ limit: '2', ...(cursor ? { cursor } : {}) })
        const context = {
          actor: { id: ACTOR_ID, role: 'admin' },
          request: { nextUrl: new URL(`http://localhost/api/admin?${query}`) },
        } as unknown as AuthedContext
        const response = await handler(context)
        const payload = await response.json()
        assert.equal(response.status, 200)
        assert.equal(payload.data.total, rows.length)
        for (const item of payload.data.items) {
          assert.equal(item.createdAt, '2026-10-18T00:00:00.123Z')
          assert.equal('cursor_created_at' in item, false)
          ids.push(item.id)
        }
        cursor = payload.data.nextCursor
        assert.equal(payload.data.hasMore, !!cursor)
        assert.ok(++pageCount <= 3, 'pagination must make progress')
      } while (cursor)
      assert.deepEqual(ids, rows.map(row => row.id))
      assert.deepEqual(boundaries, [
        [rows[1].cursor_created_at, rows[1].id],
        [rows[3].cursor_created_at, rows[3].id],
      ])
    } finally {
      pool.query = originalQuery
    }
  })

  test(`${name} still forwards legacy cursor timestamps to the SQL tuple`, async () => {
    const createdAt = '2026-10-18T00:00:00.123Z'
    const cursor = Buffer.from(JSON.stringify({ createdAt, id: ROW_ID })).toString('base64url')
    const pool = db()
    const originalQuery = pool.query
    pool.query = (async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ total: 0 }] }
      assert.deepEqual(values, [createdAt, ROW_ID, 3])
      return { rows: [] }
    }) as unknown as typeof pool.query
    try {
      await handler({
        actor: { id: ACTOR_ID, role: 'admin' },
        request: { nextUrl: new URL(`http://localhost/api/admin?limit=2&cursor=${cursor}`) },
      } as unknown as AuthedContext)
    } finally {
      pool.query = originalQuery
    }
  })
}
