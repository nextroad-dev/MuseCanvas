import { db } from '../../../../../packages/database/src/index'
import { ok } from '../../shared/http'

/** GET /api/admin/dashboard — four aggregates, one round-trip. */
export async function dashboard() {
  const result = await db().query(`SELECT (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) total_users,(SELECT count(*)::int FROM generation_jobs WHERE deleted_at IS NULL) total_jobs,(SELECT count(*)::int FROM generation_jobs WHERE status='failed' AND created_at>now()-interval '7 days') failed_jobs_7d,(SELECT COALESCE(round(100.0*count(*) FILTER(WHERE status='succeeded')/NULLIF(count(*) FILTER(WHERE status IN('succeeded','failed')),0),1),0)::float FROM generation_jobs WHERE created_at>now()-interval '7 days') success_rate_7d`)
  const row = result.rows[0]
  return ok({ totalUsers: row.total_users, totalJobs: row.total_jobs, failedJobs7d: row.failed_jobs_7d, successRate7d: row.success_rate_7d })
}
