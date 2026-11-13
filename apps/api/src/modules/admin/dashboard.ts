import { db } from '@musecanvas/database'
import { ok } from '../../shared/http'

/** 后台概览「近 7 天」序列的一项，date 为 'YYYY-MM-DD'。 */
export type DashboardDay = { date: string; total: number; succeeded: number; failed: number }

/** 数据库行：count 聚合经驱动返回时可能是字符串，转换时统一收窄。 */
type DayRow = { date: string; total: number | string; succeeded: number | string; failed: number | string }

/** 行 → DTO。缺日补 0 由 SQL 的 generate_series 保证，这里只做类型收窄，不虚构日期。 */
export function normalizeDays(rows: DayRow[]): DashboardDay[] {
  return rows.map(row => ({ date: row.date, total: Number(row.total), succeeded: Number(row.succeeded), failed: Number(row.failed) }))
}

/**
 * GET /api/admin/dashboard — 旧四个汇总 + 近 7 个自然日（含今天）逐日序列。
 *
 * 四个旧字段保留原滚动 7×24h 口径以兼容旧前端；`days` 按数据库会话时区的自然日
 * （与 current_date 同源，默认部署即 UTC）分桶，无数据日期由 generate_series 补 0，
 * 顺序最旧 → 最新。两条 SQL 分开执行以保持可读性，两段口径不同是有意的。
 */
export async function dashboard() {
  const totals = await db().query(`SELECT (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) total_users,(SELECT count(*)::int FROM generation_jobs WHERE deleted_at IS NULL) total_jobs,(SELECT count(*)::int FROM generation_jobs WHERE status='failed' AND created_at>now()-interval '7 days') failed_jobs_7d,(SELECT COALESCE(round(100.0*count(*) FILTER(WHERE status='succeeded')/NULLIF(count(*) FILTER(WHERE status IN('succeeded','failed')),0),1),0)::float FROM generation_jobs WHERE created_at>now()-interval '7 days') success_rate_7d`)
  const days = await db().query(`WITH d AS (SELECT generate_series(current_date - interval '6 days', current_date, interval '1 day')::date AS day)
SELECT to_char(d.day, 'YYYY-MM-DD') date,
       COALESCE(count(j.id), 0)::int total,
       COALESCE(count(j.id) FILTER (WHERE j.status='succeeded'), 0)::int succeeded,
       COALESCE(count(j.id) FILTER (WHERE j.status='failed'), 0)::int failed
FROM d LEFT JOIN generation_jobs j
  ON j.created_at >= d.day::timestamptz AND j.created_at < (d.day + 1)::timestamptz AND j.deleted_at IS NULL
GROUP BY d.day ORDER BY d.day`)
  const row = totals.rows[0]
  return ok({ totalUsers: row.total_users, totalJobs: row.total_jobs, failedJobs7d: row.failed_jobs_7d, successRate7d: row.success_rate_7d, days: normalizeDays(days.rows as DayRow[]) })
}
