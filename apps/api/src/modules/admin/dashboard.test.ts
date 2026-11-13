import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { db } from '@musecanvas/database'
import { dashboard, normalizeDays } from './dashboard'

const row = (date: string, total: number | string, succeeded: number | string, failed: number | string) => ({ date, total, succeeded, failed })

function mockDatabase(days: Record<string, unknown>[]) {
  const calls: { sql: string; args: unknown[] }[] = []
  const mocked = mock.method(db(), 'query', async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args })
    if (sql.includes('total_users')) return { rows: [{ total_users: 12, total_jobs: 40, failed_jobs_7d: 3, success_rate_7d: 92.5 }] }
    if (sql.includes('generate_series')) return { rows: days }
    throw new Error(`unexpected query: ${sql}`)
  })
  return { calls, restore: () => mocked.mock.restore() }
}

test('normalizeDays keeps the SQL order and narrows every count to a number', () => {
  const rows = [
    row('2026-10-16', 4, 3, 1),
    row('2026-10-17', 0, 0, 0),
    row('2026-10-18', 7, 5, 2),
    row('2026-10-19', 1, 1, 0),
    row('2026-10-20', 0, 0, 0),
    row('2026-10-21', 9, 8, 1),
    row('2026-10-22', 2, 1, 1),
  ]
  const days = normalizeDays(rows)
  assert.deepEqual(days.map(day => day.date), rows.map(item => item.date))
  assert.deepEqual(days.map(day => [day.total, day.succeeded, day.failed]), rows.map(item => [item.total, item.succeeded, item.failed]))
  for (const day of days) for (const count of [day.total, day.succeeded, day.failed]) assert.equal(typeof count, 'number')
})

test('normalizeDays narrows the string counts pg returns for bigint aggregates', () => {
  assert.deepEqual(normalizeDays([row('2026-10-22', '4', '3', '1')]), [{ date: '2026-10-22', total: 4, succeeded: 3, failed: 1 }])
})

test('normalizeDays maps an empty result to an empty series instead of inventing days', () => {
  // 7 行（含补 0 日期）由 SQL 的 generate_series 保证，转换层不补日。
  assert.deepEqual(normalizeDays([]), [])
})

test('dashboard keeps the four legacy aggregates and appends the seven-day series', async () => {
  const days = [
    { date: '2026-10-16', total: 0, succeeded: 0, failed: 0 },
    { date: '2026-10-17', total: 2, succeeded: 2, failed: 0 },
    { date: '2026-10-18', total: 1, succeeded: 0, failed: 1 },
    { date: '2026-10-19', total: 5, succeeded: 4, failed: 1 },
    { date: '2026-10-20', total: 0, succeeded: 0, failed: 0 },
    { date: '2026-10-21', total: 3, succeeded: 3, failed: 0 },
    { date: '2026-10-22', total: 2, succeeded: 1, failed: 1 },
  ]
  const f = mockDatabase(days)
  try {
    const response = await dashboard()
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).data, { totalUsers: 12, totalJobs: 40, failedJobs7d: 3, successRate7d: 92.5, days })
    assert.equal(f.calls.length, 2)
    const daysSql = f.calls.find(call => call.sql.includes('generate_series'))?.sql ?? ''
    // 逐日口径：只数未删除任务，按 status 拆成功/失败，升序且由 SQL 覆盖 7 天。
    for (const fragment of ['generate_series', 'deleted_at IS NULL', "status='succeeded'", "status='failed'", 'ORDER BY d.day']) assert.ok(daysSql.includes(fragment), fragment)
  } finally { f.restore() }
})
