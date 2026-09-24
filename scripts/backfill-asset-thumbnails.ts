/**
 * Idempotent backfill of gallery preview objects (`assets.thumbnail_*`).
 *
 * Why this exists: previews are produced by the worker at ingestion time, so
 * every asset that predates that change has no derived object and the library
 * grid would otherwise mix thumbnail tiles with full-resolution tiles — a
 * difference that is visible immediately (decode weight, progressive paint).
 *
 * Re-runnability comes from two properties, not from a ledger:
 *   1. the selection filters on `thumbnail_object_key IS NULL AND
 *      thumbnail_state IN ('none','failed')`, so each pass strictly shrinks the
 *      pending set, and permanently undecodable rows settle at 'failed';
 *   2. `thumbnailStorageKey()` is a pure function of the source key, so a retry
 *      targets the same object and overwrites it — no orphan accumulation, even
 *      when an upload succeeds and the following UPDATE does not.
 *
 * Required env: DATABASE_URL, APP_MASTER_KEY (to decrypt stored S3 credentials),
 * plus the legacy S3_* variables when storage settings live in env rather than
 * the database — the same resolution the worker itself uses.
 *
 * Usage (local, from the repo root):
 *   pnpm --filter @musecanvas/database exec tsx ../../scripts/backfill-asset-thumbnails.ts --dry-run
 *   pnpm --filter @musecanvas/database exec tsx ../../scripts/backfill-asset-thumbnails.ts --limit=500
 *
 * Video posters need ffmpeg, which ships in the worker image only, so run the
 * full sweep there:
 *   docker compose --project-directory . --env-file .env -f deploy/compose.yaml \
 *     exec worker sh -c "pnpm --filter @musecanvas/database exec tsx ../../scripts/backfill-asset-thumbnails.ts"
 * Outside that image video rows simply report `ffmpeg_unavailable` and settle at
 * 'failed', while every image row still gets its preview.
 *
 * Flags: --limit=<n> (default 500), --kind=image|video|all (default all),
 *        --dry-run (report what would be derived, touch nothing).
 */
import { db } from '../packages/database/src/index'
import {
  MAX_THUMBNAIL_SOURCE_BYTES,
  buildDerivedPreview,
  isFfmpegAvailable,
  type DerivedMediaKind,
} from '../packages/providers/src/index'
import { getStorageObject, putStorageObject } from '../apps/worker/src/shared/storage'

type Args = { limit: number; kind: 'image' | 'video' | 'all'; dryRun: boolean }

function parseArgs(argv: string[]): Args {
  const limitFlag = argv.find((entry) => entry.startsWith('--limit='))
  const kindFlag = argv.find((entry) => entry.startsWith('--kind='))
  const rawKind = kindFlag?.slice('--kind='.length)
  return {
    limit: Math.min(Math.max(Number(limitFlag?.slice('--limit='.length)) || 500, 1), 5000),
    kind: rawKind === 'image' || rawKind === 'video' ? rawKind : 'all',
    dryRun: argv.includes('--dry-run'),
  }
}

type PendingRow = {
  id: string
  object_key: string
  mime_type: string | null
  media_kind: string | null
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const conditions = ["a.deleted_at IS NULL", "a.thumbnail_object_key IS NULL", "a.thumbnail_state IN ('none','failed')"]
  const values: unknown[] = []
  if (args.kind !== 'all') {
    values.push(args.kind)
    conditions.push(`a.media_kind = $${String(values.length)}`)
  }
  values.push(args.limit)
  const rows = (await db().query(
    `SELECT a.id,a.object_key,a.mime_type,a.media_kind FROM assets a WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC LIMIT $${String(values.length)}`,
    values,
  )).rows as PendingRow[]

  console.log(`asset_thumbnail_backfill start pending=${String(rows.length)} kind=${args.kind} dryRun=${String(args.dryRun)} ffmpeg=${String(isFfmpegAvailable())}`)
  if (rows.length === 0) {
    await db().end()
    return
  }
  if (args.dryRun) {
    for (const row of rows) console.log('would_derive', { id: row.id, objectKey: row.object_key, mediaKind: row.media_kind ?? 'image' })
    await db().end()
    return
  }

  let ready = 0
  let failed = 0
  for (const row of rows) {
    const mediaKind: DerivedMediaKind = row.media_kind === 'video' ? 'video' : 'image'
    try {
      const source = await getStorageObject(row.object_key, MAX_THUMBNAIL_SOURCE_BYTES)
      const derived = await buildDerivedPreview(source, row.object_key, row.mime_type ?? 'application/octet-stream', mediaKind)
      if (derived.state !== 'ready') {
        await db().query("UPDATE assets SET thumbnail_state='failed',updated_at=now() WHERE id=$1", [row.id])
        failed += 1
        console.warn('asset_thumbnail_backfill skipped', { id: row.id, objectKey: row.object_key, reason: derived.reason })
        continue
      }
      await putStorageObject(derived.preview.objectKey, derived.preview.bytes, derived.preview.mimeType)
      // Same single-object rule as the worker: a video poster IS its preview.
      await db().query(
        `UPDATE assets SET thumbnail_object_key=$2,thumbnail_mime_type=$3,thumbnail_width=$4,thumbnail_height=$5,thumbnail_state='ready',poster_object_key=CASE WHEN $6::boolean THEN $2 ELSE poster_object_key END,updated_at=now() WHERE id=$1`,
        [
          row.id,
          derived.preview.objectKey,
          derived.preview.mimeType,
          derived.preview.width > 0 ? derived.preview.width : null,
          derived.preview.height > 0 ? derived.preview.height : null,
          mediaKind === 'video',
        ],
      )
      ready += 1
    } catch (error) {
      // A row that cannot be read or written is settled as 'failed' so the sweep
      // converges; the asset itself is untouched and still renders full-size.
      try {
        await db().query("UPDATE assets SET thumbnail_state='failed',updated_at=now() WHERE id=$1", [row.id])
      } catch {
        // Connection already gone: the loop's next iterations report it anyway.
      }
      failed += 1
      console.error('asset_thumbnail_backfill row failed', { id: row.id, objectKey: row.object_key, message: String(error) })
    }
  }
  console.log(`asset_thumbnail_backfill done ready=${String(ready)} failed=${String(failed)}`)
  await db().end()
}

main().catch(async (error) => {
  console.error('asset_thumbnail_backfill aborted', error)
  await db().end().catch(() => null)
  process.exitCode = 1
})
