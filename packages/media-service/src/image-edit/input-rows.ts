import type { SqlClient } from '../ports'

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

/** Serialize new staging with account deletion; callers keep this lock in a short transaction. */
export async function requireActiveInputOwner(client: SqlClient, ownerId: string): Promise<void> {
  const owner = await client.query("SELECT id FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL FOR NO KEY UPDATE", [ownerId])
  if (!owner.rows.length) throw new Error('INPUT_OWNER_INACTIVE')
}

/**
 * Write the dual inspected input row. The manual path defaults to `ready` after
 * PUT. Reserved Agent masks use `pending` BEFORE immutable PUT so existing TTL
 * cleanup can reclaim an orphan object; the preparation lease later fences both
 * rows' pending→ready transition. Geometry/checksum describe the exact bytes.
 * Requires both input tables from the current migrated schema.
 */
export async function storeReadyInputImage(client: SqlClient, row: ReadyInputWrite, status: 'ready' | 'pending' = 'ready'): Promise<void> {
  await requireActiveInputOwner(client, row.actorId)
  const statusSql = status === 'pending' ? "'pending'" : "'ready'"
  // Keyed edits derive the same upload id for the same artifact, so a retried
  // request must not fail on the row it already wrote — and must not overwrite
  // it with different bytes either. The follow-up read is the arbiter.
  await client.query(
    `INSERT INTO media_uploads(id, created_by, media_kind, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
     VALUES($1, $2, 'image', ${statusSql}, $3, $4, $5, $6, $7, $8, COALESCE($10::timestamptz, now() + ($9 * interval '1 second'))) ON CONFLICT (id) DO NOTHING`,
    [row.uploadId, row.actorId, row.objectKey, row.mimeType, row.width, row.height, row.sizeBytes, row.checksum, row.ttlSeconds, row.expiresAt ?? null]
  )
  await client.query(
    `INSERT INTO generation_input_images(id, created_by, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
     VALUES($1, $2, ${statusSql}, $3, $4, $5, $6, $7, $8, COALESCE($10::timestamptz, now() + ($9 * interval '1 second'))) ON CONFLICT (id) DO NOTHING`,
    [row.uploadId, row.actorId, row.objectKey, row.mimeType, row.width, row.height, row.sizeBytes, row.checksum, row.ttlSeconds, row.expiresAt ?? null]
  )
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

/** Compatibility export for application callers; shared writes do not suppress SQL errors. */
export function mirrorTableMissing(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === '42P01') return true
  const message = error instanceof Error ? error.message : ''
  return message.includes('42P01') || message.includes('relation "media_uploads" does not exist')
}

/**
 * Lock the media mirror before the legacy row: the shared attach path takes
 * `media_uploads` first, then `generation_input_images`, and inverting that
 * order deadlocks the two against each other. SQL failures must abort the caller transaction.
 */
async function lockMediaRowForUpdate(client: SqlClient, uploadId: string): Promise<Record<string, unknown> | undefined> {
  const locked = await client.query(
    'SELECT created_by, object_key, mime_type, width, height, size_bytes, checksum, status, object_deleted_at, expires_at FROM media_uploads WHERE id=$1 FOR UPDATE',
    [uploadId]
  )
  return locked.rows[0]
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
  await requireActiveInputOwner(client, row.actorId)
  const params = [row.uploadId, row.actorId, row.objectKey, row.mimeType, row.width, row.height, row.sizeBytes, row.checksum, row.ttlSeconds, row.expiresAt ?? null]
  await client.query(
    `INSERT INTO media_uploads(id, created_by, media_kind, status, object_key, mime_type, width, height, size_bytes, checksum, expires_at)
     VALUES($1, $2, 'image', 'pending', $3, $4, $5, $6, $7, $8, COALESCE($10::timestamptz, now() + ($9 * interval '1 second'))) ON CONFLICT (id) DO NOTHING`,
    params
  )
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
  await client.query(
    "UPDATE media_uploads SET expires_at = COALESCE($2::timestamptz, now() + ($3 * interval '1 second')), updated_at=now() WHERE id=$1 AND status IN ('pending','ready')",
    [row.uploadId, row.expiresAt ?? null, row.ttlSeconds]
  )
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
  await requireActiveInputOwner(client, row.actorId)
  const mirror = await lockMediaRowForUpdate(client, row.uploadId)
  const stored = await client.query(
    'SELECT created_by, object_key, mime_type, width, height, size_bytes, checksum, status, object_deleted_at FROM generation_input_images WHERE id=$1 FOR UPDATE',
    [row.uploadId]
  )
  const existing = stored.rows[0]
  if (!existing || !rowIdentityMatches(existing, row)) throw new Error('INPUT_ROW_CONFLICT')
  if (mirror && !rowIdentityMatches(mirror, row)) throw new Error('INPUT_ROW_CONFLICT')
  if (rowTombstoned(existing) || (mirror && rowTombstoned(mirror))) throw new Error('INPUT_ROW_RECLAIMED')
  await client.query("UPDATE media_uploads SET status='ready', updated_at=now() WHERE id=$1 AND status='pending'", [row.uploadId])
  if (String(existing.status) === 'pending') {
    await client.query("UPDATE generation_input_images SET status='ready', updated_at=now() WHERE id=$1 AND status='pending'", [row.uploadId])
  }
}
