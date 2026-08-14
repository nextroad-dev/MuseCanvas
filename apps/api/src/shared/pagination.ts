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

export const userJobSelect = `SELECT j.*,po.input_prompt,po.final_prompt,po.template_name_snapshot,po.status optimization_status,s.allow_user_read_final_prompt
  FROM generation_jobs j LEFT JOIN prompt_optimizations po ON po.id=j.prompt_optimization_id AND po.deleted_at IS NULL
  CROSS JOIN prompt_optimization_settings s`