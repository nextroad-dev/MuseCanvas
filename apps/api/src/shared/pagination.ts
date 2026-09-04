import type { NextRequest } from 'next/server'

export type Cursor = { createdAt: string; id: string }

export function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor
    return typeof parsed.createdAt === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed.id) &&
      !Number.isNaN(Date.parse(parsed.createdAt))
      ? parsed
      : null
  } catch {
    return null
  }
}

export const encodeCursor = (row: { created_at: Date; id: string }) =>
  Buffer.from(JSON.stringify({ createdAt: row.created_at.toISOString(), id: row.id })).toString('base64url')

export const boundedLimit = (request: NextRequest) =>
  Math.min(100, Math.max(1, Number(request.nextUrl.searchParams.get('limit') || 50) || 50))

export const userJobSelect = `SELECT j.*,po.input_prompt,po.final_prompt,po.template_name_snapshot,po.status optimization_status,s.allow_user_read_final_prompt,gc.quoted_credits,gc.state AS billing_state
  FROM generation_jobs j LEFT JOIN prompt_optimizations po ON po.id=j.prompt_optimization_id AND po.deleted_at IS NULL
  LEFT JOIN generation_charges gc ON gc.job_id=j.id
  CROSS JOIN prompt_optimization_settings s`

export type JobInputRecord = {
  id: string
  object_key: string
  mime_type: string
  width: number
  height: number
  size_bytes: number
  position: number
  role: string
  upload_id: string
}

export async function loadJobInputs(
  dbClient: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  jobIds: string[]
): Promise<Record<string, JobInputRecord[]>> {
  if (jobIds.length === 0) return {}
  let res
  try {
    res = await dbClient.query(
      `SELECT gji.job_id, COALESCE(mu.id, gi.id) AS id,
              COALESCE(mu.object_key, gi.object_key) AS object_key,
              COALESCE(mu.mime_type, gi.mime_type) AS mime_type,
              COALESCE(mu.width, gi.width) AS width, COALESCE(mu.height, gi.height) AS height,
              COALESCE(mu.size_bytes, gi.size_bytes) AS size_bytes,
              gji.position, COALESCE(gji.role, 'reference_image') AS role,
              COALESCE(gji.upload_id::text, gi.id::text) AS upload_id
       FROM generation_job_inputs gji
       LEFT JOIN media_uploads mu ON mu.id = gji.upload_id
       LEFT JOIN generation_input_images gi ON gi.id = gji.input_image_id OR gi.id = gji.upload_id
       WHERE gji.job_id = ANY($1)
       ORDER BY gji.job_id, gji.position ASC`,
      [jobIds]
    )
  } catch {
    res = await dbClient.query(
      `SELECT gji.job_id, gi.id, gi.object_key, gi.mime_type, gi.width, gi.height, gi.size_bytes, gji.position,
              'reference_image' AS role, gi.id::text AS upload_id
       FROM generation_job_inputs gji
       JOIN generation_input_images gi ON gi.id=gji.input_image_id
       WHERE gji.job_id = ANY($1)
       ORDER BY gji.job_id, gji.position ASC`,
      [jobIds]
    )
  }
  const map: Record<string, JobInputRecord[]> = {}
  for (const row of res.rows) {
    const jobId = row.job_id as string
    if (!map[jobId]) map[jobId] = []
    map[jobId].push({
      id: row.id as string,
      object_key: row.object_key as string,
      mime_type: row.mime_type as string,
      width: Number(row.width || 0),
      height: Number(row.height || 0),
      size_bytes: Number(row.size_bytes || 0),
      position: Number(row.position || 0),
      role: (row.role as string) || 'reference_image',
      upload_id: (row.upload_id as string) || (row.id as string),
    })
  }
  return map
}

export async function loadSingleJobInputs(
  dbClient: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  jobId: string
): Promise<JobInputRecord[]> {
  const byJob = await loadJobInputs(dbClient, [jobId])
  return byJob[jobId] || []
}
