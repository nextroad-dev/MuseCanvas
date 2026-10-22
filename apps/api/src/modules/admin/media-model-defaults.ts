import type pg from 'pg'
import { parseUpdateMediaModelDefaultsRequest, type MediaModelDefaultsDto } from '@musecanvas/contracts'
import { db, transaction } from '@musecanvas/database'
import type { Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { writeAudit } from '../../shared/audit'

const KINDS = ['image', 'video'] as const
type MediaModelKind = (typeof KINDS)[number]
const KEY_BY_KIND: Record<MediaModelKind, 'imageModelId' | 'videoModelId'> = {
  image: 'imageModelId',
  video: 'videoModelId',
}

type DefaultsRow = { id: string; model_kind: string; updated_at?: string | Date | null }

function defaultsDto(rows: DefaultsRow[]): MediaModelDefaultsDto {
  const byKind = new Map(rows.map(row => [row.model_kind, row.id as string]))
  const stamps = rows
    .map(row => (row.updated_at ? new Date(row.updated_at).getTime() : NaN))
    .filter(stamp => Number.isFinite(stamp))
  return {
    imageModelId: byKind.get('image') ?? null,
    videoModelId: byKind.get('video') ?? null,
    updatedAt: new Date(stamps.length ? Math.max(...stamps) : Date.now()).toISOString(),
  }
}

async function liveDefaults(client: pg.Pool | pg.PoolClient): Promise<DefaultsRow[]> {
  return (await client.query(
    'SELECT id, model_kind, updated_at FROM model_configs WHERE is_default AND deleted_at IS NULL AND model_kind IN (\'image\',\'video\')',
  )).rows as DefaultsRow[]
}

class DefaultsError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
  }
}

export async function readMediaModelDefaults(actor: Actor) {
  if (actor.role !== 'admin') return fail('FORBIDDEN', 'FORBIDDEN', 403)
  return ok(defaultsDto(await liveDefaults(db())))
}

export async function updateMediaModelDefaults(actor: Actor, input: unknown) {
  if (actor.role !== 'admin') return fail('FORBIDDEN', 'FORBIDDEN', 403)
  const parsed = parseUpdateMediaModelDefaultsRequest(input)
  if (!parsed.success) return fail(parsed.error.code, parsed.error.message, 400)
  try {
    const dto = await transaction(async (client) => {
      for (const kind of KINDS) {
        const elected = parsed.data[KEY_BY_KIND[kind]]
        if (elected === undefined) continue
        const found = (await client.query(
          'SELECT id, model_kind, enabled, deleted_at FROM model_configs WHERE id=$1 FOR UPDATE',
          [elected],
        )).rows[0] as { id?: string; model_kind?: string; enabled?: boolean; deleted_at?: unknown } | undefined
        if (!found?.id || found.deleted_at || !found.enabled || found.model_kind !== kind) {
          throw new DefaultsError(
            'DEFAULT_MODEL_INVALID',
            400,
            `默认${kind === 'image' ? '图像' : '视频'}模型无效：模型不存在、已删除、未启用或类型不符`,
          )
        }
        await client.query(
          'UPDATE model_configs SET is_default=false,updated_at=now() WHERE model_kind=$1 AND is_default AND deleted_at IS NULL AND id<>$2',
          [kind, elected],
        )
        await client.query('UPDATE model_configs SET is_default=true,updated_at=now() WHERE id=$1', [elected])
      }
      await writeAudit(client, actor.id, 'media_model_defaults.update', 'settings', 'media_model_defaults', parsed.data)
      return defaultsDto(await liveDefaults(client))
    })
    return ok(dto)
  } catch (error) {
    if (error instanceof DefaultsError) return fail(error.code, error.message, error.status)
    return fail('SETTINGS_UPDATE_FAILED', '更新默认模型失败', 503)
  }
}
