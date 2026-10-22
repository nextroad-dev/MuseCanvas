import type { NextResponse } from 'next/server'
import { RUNTIME_SETTINGS_DEFAULTS } from '@musecanvas/contracts'
import { db, transaction } from '@musecanvas/database'
import { limited } from '../../shared/redis'
import {
  deleteS3Object,
  getPrivateS3ObjectBytes,
  putPrivateS3ObjectBytes,
  putReservedImageMask,
} from '../../shared/services'
import { GENERATION_UPLOAD_TTL_SECONDS } from '../generation-uploads'
import { resolveRuntimeSettings } from '../settings/runtime'
import { createGenerationJob, type CreateGenerationJobCommand } from '../generations/create-job'

/**
 * Row-store primitives and the collaborator seam for image edits, extracted from
 * `handlers.ts` into their own module.
 *
 * `handlers.ts` and `prepare.ts` each needed values from the other (the route
 * needs `prepareImageEdit`, preparation needs the port bundle and the input-row
 * helpers), which made a runtime import cycle. Both now depend on this leaf-ish
 * module instead, and `handlers.ts` re-exports the symbols it used to own so
 * every existing importer keeps working. Behavior is unchanged.
 */

/** Minimal pg surface this route touches, so every branch is testable against a stub. */
export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export interface ImageEditUploadLimits {
  maxImageBytes: number
  uploadTtlSeconds: number
}

/**
 * The collaborators `editImage` needs. Production wiring is `defaultImageEditPorts`;
 * a test passes stubs. The seam exists because the promises worth asserting here —
 * "no object was written", "the row says `ready` with *this* checksum", "the count
 * is 1" — are only observable against an injected boundary, and this repo's runner
 * has no module mocking.
 */
export interface ImageEditPorts {
  db: () => SqlClient
  runTransaction: (fn: (client: SqlClient) => Promise<void>) => Promise<void>
  limited: (key: string, max: number, seconds: number) => Promise<boolean>
  readObjectBytes: (objectKey: string) => Promise<Buffer>
  putObjectBytes: (objectKey: string, bytes: Buffer, contentType: string) => Promise<void>
  putReservedMask?: (objectKey: string, bytes: Buffer) => Promise<void>
  deleteObject: (objectKey: string) => Promise<void>
  uploadLimits: () => Promise<ImageEditUploadLimits>
  createJob: (cmd: CreateGenerationJobCommand) => Promise<NextResponse>
}

/** Runtime settings first, canonical defaults last — the same resolution order the upload routes use. */
export async function resolveImageEditUploadLimits(): Promise<ImageEditUploadLimits> {
  try {
    const runtime = await resolveRuntimeSettings()
    return { maxImageBytes: runtime.maxImageBytes, uploadTtlSeconds: runtime.uploadTtlSeconds }
  } catch {
    return {
      maxImageBytes: RUNTIME_SETTINGS_DEFAULTS.maxImageBytes,
      uploadTtlSeconds: GENERATION_UPLOAD_TTL_SECONDS,
    }
  }
}

export const defaultImageEditPorts: ImageEditPorts = {
  db: () => db(),
  runTransaction: fn => transaction(async client => { await fn(client) }),
  limited,
  readObjectBytes: objectKey => getPrivateS3ObjectBytes(objectKey),
  putObjectBytes: (objectKey, bytes, contentType) => putPrivateS3ObjectBytes(objectKey, bytes, contentType),
  putReservedMask: putReservedImageMask,
  deleteObject: objectKey => deleteS3Object(objectKey),
  uploadLimits: resolveImageEditUploadLimits,
  createJob: cmd => createGenerationJob(cmd),
}

/** A row created already in `ready` state: geometry, digest and length of the exact bytes in the bucket. */
export interface ReadyInputWrite {
  uploadId: string
  actorId: string
  objectKey: string
  mimeType: string
  width: number
  height: number
  sizeBytes: number
  checksum: string
  ttlSeconds: number
  expiresAt?: string
}

/**
 * Write the dual inspected input row. The manual path defaults to `ready` after
 * PUT. Reserved Agent masks use `pending` BEFORE immutable PUT so existing TTL
 * cleanup can reclaim an orphan object; the preparation lease later fences both
 * rows' pending→ready transition. Geometry/checksum describe the exact bytes.
 * The legacy mirror fallback is retained for the unchanged manual path.
 */
export async function storeReadyInputImage(client: SqlClient, row: ReadyInputWrite, status: 'ready' | 'pending' = 'ready'): Promise<void> {
  const statusSql = status === 'pending' ? "'pending'" : "'ready'"
  // Keyed edits derive the same upload id for the same artifact, so a retried
  // request must not fail on the row it already wrote — and must not overwrite
  // it with different bytes either. The follow-up read is the arbiter.
  await client.query(
    `INSERT INTO generation_input_images(id, created_by, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
     VALUES($1, $2, ${statusSql}, $3, $4, $5, $6, $7, $8, COALESCE($10::timestamptz, now() + ($9 * interval '1 second'))) ON CONFLICT (id) DO NOTHING`,
    [row.uploadId, row.actorId, row.objectKey, row.mimeType, row.width, row.height, row.sizeBytes, row.checksum, row.ttlSeconds, row.expiresAt ?? null]
  )
  try {
    await client.query(
      `INSERT INTO media_uploads(id, created_by, media_kind, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
       VALUES($1, $2, 'image', ${statusSql}, $3, $4, $5, $6, $7, $8, COALESCE($10::timestamptz, now() + ($9 * interval '1 second'))) ON CONFLICT (id) DO NOTHING`,
      [row.uploadId, row.actorId, row.objectKey, row.mimeType, row.width, row.height, row.sizeBytes, row.checksum, row.ttlSeconds, row.expiresAt ?? null]
    )
  } catch {
    // media_uploads table may not exist on older databases; the legacy row stays source of truth.
  }
  const stored = await client.query(
    'SELECT created_by, object_key, mime_type, width, height, size_bytes, checksum FROM generation_input_images WHERE id=$1',
    [row.uploadId]
  )
  const existing = stored.rows[0]
  if (existing && !rowIdentityMatches(existing, row)) throw new Error('INPUT_ROW_CONFLICT')
}

/** The stored row describes exactly the artifact this caller staged. */
const rowIdentityMatches = (existing: Record<string, unknown>, row: ReadyInputWrite): boolean =>
  String(existing.created_by) === row.actorId
  && String(existing.object_key) === row.objectKey
  && String(existing.mime_type) === row.mimeType
  && Number(existing.width) === row.width
  && Number(existing.height) === row.height
  && Number(existing.size_bytes) === row.sizeBytes
  && String(existing.checksum) === row.checksum

/** A row the TTL sweep already reclaimed: it must not be rebuilt underneath. */
const rowTombstoned = (row: Record<string, unknown>): boolean =>
  String(row.status) === 'deleted' || Boolean(row.object_deleted_at)

/**
 * Lock the media mirror before the legacy row: the shared attach path takes
 * `media_uploads` first, then `generation_input_images`, and inverting that
 * order deadlocks the two against each other. An absent mirror table (older
 * databases) is skipped rather than failing the write.
 */
/** Only a genuinely missing mirror table is tolerated; any other error must fail loudly. */
export function mirrorTableMissing(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === '42P01') return true
  const message = error instanceof Error ? error.message : ''
  return message.includes('42P01') || message.includes('relation "media_uploads" does not exist')
}

async function lockMediaRowForUpdate(client: SqlClient, uploadId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const locked = await client.query(
      'SELECT created_by, object_key, mime_type, width, height, size_bytes, checksum, status, object_deleted_at, expires_at FROM media_uploads WHERE id=$1 FOR UPDATE',
      [uploadId]
    )
    return locked.rows[0]
  } catch (error) {
    if (!mirrorTableMissing(error)) throw error
    return undefined
  }
}

/**
 * Row-first claim for a key-scoped idempotent edit.
 *
 * The row exists before any object is written, so a failed attempt leaves a
 * TTL-reclaimable pending row instead of a shared object that a concurrent
 * loser could delete, or an object no row can ever reclaim. Rows whose object
 * was already reclaimed, or whose unattached lifetime already expired, are
 * refused rather than rebuilt underneath the tombstone: the caller must start a
 * new request (a new idempotency key) instead.
 */
export async function claimKeyedInputRow(client: SqlClient, row: ReadyInputWrite): Promise<void> {
  const params = [row.uploadId, row.actorId, row.objectKey, row.mimeType, row.width, row.height, row.sizeBytes, row.checksum, row.ttlSeconds, row.expiresAt ?? null]
  try {
    await client.query(
      `INSERT INTO media_uploads(id, created_by, media_kind, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
       VALUES($1, $2, 'image', 'pending', $3, $4, $5, $6, $7, $8, COALESCE($10::timestamptz, now() + ($9 * interval '1 second'))) ON CONFLICT (id) DO NOTHING`,
      params
    )
  } catch (error) {
    // media_uploads may not exist on older databases; the legacy row stays source of truth.
    if (!mirrorTableMissing(error)) throw error
  }
  const mirror = await lockMediaRowForUpdate(client, row.uploadId)
  await client.query(
    `INSERT INTO generation_input_images(id, created_by, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
     VALUES($1, $2, 'pending', $3, $4, $5, $6, $7, $8, COALESCE($10::timestamptz, now() + ($9 * interval '1 second'))) ON CONFLICT (id) DO NOTHING`,
    params
  )
  const stored = await client.query(
    'SELECT created_by, object_key, mime_type, width, height, size_bytes, checksum, status, object_deleted_at, expires_at FROM generation_input_images WHERE id=$1 FOR UPDATE',
    [row.uploadId]
  )
  const existing = stored.rows[0]
  if (!existing || !rowIdentityMatches(existing, row)) throw new Error('INPUT_ROW_CONFLICT')
  if (mirror && !rowIdentityMatches(mirror, row)) throw new Error('INPUT_ROW_CONFLICT')
  if (rowTombstoned(existing) || (mirror && rowTombstoned(mirror))) throw new Error('INPUT_ROW_RECLAIMED')
  if (Number(new Date(existing.expires_at as string | number | Date)) <= Date.now()) throw new Error('INPUT_ROW_RECLAIMED')
  if (mirror && Number(new Date(mirror.expires_at as string | number | Date)) <= Date.now()) throw new Error('INPUT_ROW_RECLAIMED')
  try {
    await client.query(
      "UPDATE media_uploads SET expires_at = COALESCE($2::timestamptz, now() + ($3 * interval '1 second')), updated_at=now() WHERE id=$1 AND status IN ('pending','ready')",
      [row.uploadId, row.expiresAt ?? null, row.ttlSeconds]
    )
  } catch (error) {
    // Missing generic table on older databases is tolerated consistently.
    if (!mirrorTableMissing(error)) throw error
  }
  await client.query(
    "UPDATE generation_input_images SET expires_at = COALESCE($2::timestamptz, now() + ($3 * interval '1 second')), updated_at=now() WHERE id=$1 AND status IN ('pending','ready')",
    [row.uploadId, row.expiresAt ?? null, row.ttlSeconds]
  )
}

/**
 * Promote a claimed keyed row after its object write. A concurrent request may
 * already have promoted (or attached) it; only `pending` is advanced, and a
 * reclaimed row fails closed.
 */
export async function promoteKeyedInputRow(client: SqlClient, row: ReadyInputWrite): Promise<void> {
  const mirror = await lockMediaRowForUpdate(client, row.uploadId)
  const stored = await client.query(
    'SELECT created_by, object_key, mime_type, width, height, size_bytes, checksum, status, object_deleted_at FROM generation_input_images WHERE id=$1 FOR UPDATE',
    [row.uploadId]
  )
  const existing = stored.rows[0]
  if (!existing || !rowIdentityMatches(existing, row)) throw new Error('INPUT_ROW_CONFLICT')
  if (mirror && !rowIdentityMatches(mirror, row)) throw new Error('INPUT_ROW_CONFLICT')
  if (rowTombstoned(existing) || (mirror && rowTombstoned(mirror))) throw new Error('INPUT_ROW_RECLAIMED')
  try {
    await client.query("UPDATE media_uploads SET status='ready', updated_at=now() WHERE id=$1 AND status='pending'", [row.uploadId])
  } catch (error) {
    // Missing generic table on older databases is tolerated consistently.
    if (!mirrorTableMissing(error)) throw error
  }
  if (String(existing.status) === 'pending') {
    await client.query("UPDATE generation_input_images SET status='ready', updated_at=now() WHERE id=$1 AND status='pending'", [row.uploadId])
  }
}
