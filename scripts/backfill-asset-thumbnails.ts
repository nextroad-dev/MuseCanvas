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
 *      thumbnail_state IN ('none','failed')`; failed rows remain retryable;
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
 *   # Continue with the nextCursor printed by the previous batch (same --kind):
 *   pnpm --filter @musecanvas/database exec tsx ../../scripts/backfill-asset-thumbnails.ts --limit=500 --cursor=<nextCursor>
 * Each invocation processes at most --limit rows, newest first. Continue until
 * nextCursor=none. A full batch may require one final empty invocation. Omit
 * --cursor to start a new sweep and retry failures (also after fixing ffmpeg).
 * Keep --kind and --dry-run unchanged while continuing a sweep. Dry-run cursors
 * only advance the preview; omit --cursor when starting the real backfill.
 * Newer arrivals after a batch are picked up by the next fresh sweep.
 *
 * Video posters need ffmpeg, which ships in the worker image only, so run the
 * video batches there (repeat with --cursor as above):
 *   docker compose --project-directory . --env-file .env -f deploy/compose.yaml \
 *     exec worker sh -c "pnpm --filter @musecanvas/database exec tsx ../../scripts/backfill-asset-thumbnails.ts"
 * Outside that image video rows simply report `ffmpeg_unavailable` and settle at
 * 'failed', while every image row still gets its preview.
 *
 * Flags: --limit=<n> (default 500), --kind=image|video|all (default all),
 *        --dry-run (report what would be derived, touch nothing),
 *        --cursor=<opaque token> (resume strictly after the previous batch).
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DerivedMediaKind } from '../packages/providers/src/index'

type Kind = 'image' | 'video' | 'all'
type Cursor = { createdAt: string; id: string; kind: Kind; dryRun: boolean }
type Args = { limit: number; kind: Kind; dryRun: boolean; cursor: Cursor | null }

function decodeCursor(token: string): Cursor {
  const invalid = (): never => { throw new Error('Invalid --cursor') }
  if (token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) invalid()
  const bytes = Buffer.from(token, 'base64url')
  if (bytes.toString('base64url') !== token) invalid()
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { invalid() }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid()
  const value = parsed as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== 'createdAt,dryRun,id,kind'
    || typeof value.id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.id)
    || !['all', 'image', 'video'].includes(String(value.kind)) || typeof value.dryRun !== 'boolean'
    || typeof value.createdAt !== 'string') invalid()
  const time = value.createdAt as string
  // Do not round-trip through Date: PostgreSQL timestamps carry microseconds.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(time) || time.startsWith('0000')) invalid()
  const date = new Date(time)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== `${time.slice(0, 23)}Z`) invalid()
  return value as Cursor
}

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>()
  for (const entry of argv) {
    const match = /^(--limit|--kind|--cursor)=(.*)$/.exec(entry)
    const name = match?.[1] ?? entry
    if ((!match && entry !== '--dry-run') || flags.has(name)) throw new Error(`Invalid or duplicate argument: ${entry}`)
    flags.set(name, match?.[2] ?? '')
  }
  const rawLimit = flags.get('--limit') ?? '500'
  const limit = Number(rawLimit)
  if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error('--limit must be an integer from 1 to 5000')
  const kind = flags.get('--kind') ?? 'all'
  if (kind !== 'all' && kind !== 'image' && kind !== 'video') throw new Error('--kind must be image, video or all')
  const dryRun = flags.has('--dry-run')
  const cursor = flags.has('--cursor') ? decodeCursor(flags.get('--cursor')!) : null
  if (cursor && (cursor.kind !== kind || cursor.dryRun !== dryRun)) throw new Error('--cursor requires the same --kind and --dry-run mode')
  return { limit, kind, dryRun, cursor }
}

type PendingRow = {
  id: string
  object_key: string
  mime_type: string | null
  media_kind: string | null
  cursor_created_at: string
}

type Dependencies = {
  database: { query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }> }
  getStorageObject: typeof import('../apps/worker/src/shared/storage').getStorageObject
  putStorageObject: typeof import('../apps/worker/src/shared/storage').putStorageObject
  buildDerivedPreview: typeof import('../packages/providers/src/index').buildDerivedPreview
  isFfmpegAvailable: () => boolean
  MAX_THUMBNAIL_SOURCE_BYTES: number
}

export async function runBackfill(args: Args, deps: Dependencies): Promise<string | null> {
  const { database, getStorageObject, putStorageObject, buildDerivedPreview, isFfmpegAvailable, MAX_THUMBNAIL_SOURCE_BYTES } = deps
  const conditions = ["a.deleted_at IS NULL", "a.thumbnail_object_key IS NULL", "a.thumbnail_state IN ('none','failed')"]
  const values: unknown[] = []
  if (args.kind !== 'all') {
    values.push(args.kind)
    conditions.push(`a.media_kind = $${String(values.length)}`)
  }
  if (args.cursor) {
    values.push(args.cursor.createdAt, args.cursor.id)
    conditions.push(`(a.created_at, a.id) < ($${String(values.length - 1)}::timestamptz, $${String(values.length)}::uuid)`)
  }
  values.push(args.limit)
  const rows = (await database.query(
    `SELECT a.id,a.object_key,a.mime_type,a.media_kind,to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at FROM assets a WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT $${String(values.length)}`,
    values,
  )).rows as PendingRow[]
  const last = rows.at(-1)
  const nextCursor = rows.length === args.limit && last
    ? Buffer.from(JSON.stringify({ createdAt: last.cursor_created_at, id: last.id, kind: args.kind, dryRun: args.dryRun })).toString('base64url')
    : null
  const finish = (): string | null => {
    console.log(`asset_thumbnail_backfill nextCursor=${nextCursor ?? 'none'}`)
    return nextCursor
  }

  console.log(`asset_thumbnail_backfill start pending=${String(rows.length)} kind=${args.kind} dryRun=${String(args.dryRun)} ffmpeg=${String(isFfmpegAvailable())}`)
  if (rows.length === 0) {
    return finish()
  }
  if (args.dryRun) {
    for (const row of rows) console.log('would_derive', { id: row.id, objectKey: row.object_key, mediaKind: row.media_kind ?? 'image' })
    return finish()
  }

  let ready = 0
  let failed = 0
  for (const row of rows) {
    const mediaKind: DerivedMediaKind = row.media_kind === 'video' ? 'video' : 'image'
    try {
      const source = await getStorageObject(row.object_key, MAX_THUMBNAIL_SOURCE_BYTES)
      const derived = await buildDerivedPreview(source, row.object_key, row.mime_type ?? 'application/octet-stream', mediaKind)
      if (derived.state !== 'ready') {
        await database.query("UPDATE assets SET thumbnail_state='failed',updated_at=now() WHERE id=$1", [row.id])
        failed += 1
        console.warn('asset_thumbnail_backfill skipped', { id: row.id, objectKey: row.object_key, reason: derived.reason })
        continue
      }
      await putStorageObject(derived.preview.objectKey, derived.preview.bytes, derived.preview.mimeType)
      // Same single-object rule as the worker: a video poster IS its preview.
      await database.query(
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
      // Failures remain eligible for a fresh sweep; the cursor lets this sweep
      // advance without repeatedly selecting them. The source stays untouched.
      try {
        await database.query("UPDATE assets SET thumbnail_state='failed',updated_at=now() WHERE id=$1", [row.id])
      } catch {
        // Connection already gone: the loop's next iterations report it anyway.
      }
      failed += 1
      console.error('asset_thumbnail_backfill row failed', { id: row.id, objectKey: row.object_key, message: String(error) })
    }
  }
  console.log(`asset_thumbnail_backfill done ready=${String(ready)} failed=${String(failed)}`)
  return finish()
}

async function main(): Promise<void> {
  // Validate before loading any database, storage or credential-dependent code.
  const args = parseArgs(process.argv.slice(2))
  const [{ db }, providers, storage] = await Promise.all([
    import('../packages/database/src/index'),
    import('../packages/providers/src/index'),
    import('../apps/worker/src/shared/storage'),
  ])
  const database = db()
  try {
    await runBackfill(args, { database, ...providers, ...storage })
  } finally {
    await database.end()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('asset_thumbnail_backfill aborted', error)
    process.exitCode = 1
  })
}
