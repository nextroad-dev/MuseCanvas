import { createHash } from 'node:crypto'
import type pg from 'pg'
import {
  bumpConfigRevision,
  type PromptTemplateSetEntity,
  type PromptTemplateSetRow,
  type PromptTemplateEntryEntity,
  type PromptTemplateEntryRow,
  toPromptTemplateSetEntity,
  toPromptTemplateEntryEntity,
} from './onboarding'

export interface PromptTemplateSetWithEntries extends PromptTemplateSetEntity {
  entries: PromptTemplateEntryEntity[]
}

export interface PromptTemplateEntryInput {
  name: string
  description?: string
  instruction: string
  path?: string
  sortOrder?: number
}

export const PROMPT_TEMPLATE_MAX_ENTRIES = 100
export const PROMPT_TEMPLATE_MAX_SORT_ORDER = 1000000

function assertValidSortOrder(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > PROMPT_TEMPLATE_MAX_SORT_ORDER) {
    throw new Error('INVALID_INPUT')
  }
}

/**
 * Deterministic content digest over the full ordered entry list. The digest
 * covers name + description + instruction so any created version can refresh
 * its `content_digest` from the exact rows it inserted.
 */
export function computePromptTemplateDigest(
  entries: Array<{ name: string; description?: string; instruction: string }>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        entries.map((entry) => ({
          name: entry.name,
          description: entry.description ?? '',
          instruction: entry.instruction,
        })),
      ),
    )
    .digest('hex')
}

export function promptTemplateEntrySha256(instruction: string): string {
  return createHash('sha256').update(instruction, 'utf8').digest('hex')
}

/**
 * List all prompt template sets ordered by version descending.
 */
export async function listPromptTemplateSets(
  client: pg.PoolClient | pg.Pool,
): Promise<PromptTemplateSetEntity[]> {
  const res = await client.query(
    `SELECT * FROM prompt_template_sets
     ORDER BY version DESC, created_at DESC`,
  )
  return (res.rows as PromptTemplateSetRow[]).map(toPromptTemplateSetEntity)
}

/**
 * Get a prompt template set by its UUID.
 */
export async function getPromptTemplateSetById(
  client: pg.PoolClient | pg.Pool,
  setId: string,
): Promise<PromptTemplateSetEntity | null> {
  const res = await client.query(
    `SELECT * FROM prompt_template_sets WHERE id = $1`,
    [setId],
  )
  if (!res.rows[0]) return null
  return toPromptTemplateSetEntity(res.rows[0] as PromptTemplateSetRow)
}

/**
 * Get a prompt template set along with all of its entries.
 */
export async function getPromptTemplateSetWithEntries(
  client: pg.PoolClient | pg.Pool,
  setId: string,
): Promise<PromptTemplateSetWithEntries | null> {
  const set = await getPromptTemplateSetById(client, setId)
  if (!set) return null
  const entriesRes = await client.query(
    `SELECT * FROM prompt_template_entries
     WHERE set_id = $1
     ORDER BY sort_order ASC, name ASC`,
    [setId],
  )
  const entries = (entriesRes.rows as PromptTemplateEntryRow[]).map(toPromptTemplateEntryEntity)
  return { ...set, entries }
}

/**
 * Get the currently active prompt template set along with all of its entries.
 */
export async function getActivePromptTemplateSetWithEntries(
  client: pg.PoolClient | pg.Pool,
): Promise<PromptTemplateSetWithEntries | null> {
  const res = await client.query(
    `SELECT * FROM prompt_template_sets
     WHERE is_active = true
     ORDER BY version DESC
     LIMIT 1`,
  )
  if (!res.rows[0]) return null
  const set = toPromptTemplateSetEntity(res.rows[0] as PromptTemplateSetRow)
  const entriesRes = await client.query(
    `SELECT * FROM prompt_template_entries
     WHERE set_id = $1
     ORDER BY sort_order ASC, name ASC`,
    [set.id],
  )
  const entries = (entriesRes.rows as PromptTemplateEntryRow[]).map(toPromptTemplateEntryEntity)
  return { ...set, entries }
}

/**
 * Transaction-scoped advisory locks serializing version allocation (per set
 * name) and active-set swaps (global). `pg_advisory_xact_lock` releases
 * automatically at transaction end, so concurrent imports/forks/activations
 * cannot allocate duplicate versions or leave two sets active.
 */
async function lockPromptTemplateVersion(client: pg.PoolClient, name: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('prompt_template_version:' || $1))`, [name])
}

async function lockPromptTemplateActiveSwap(client: pg.PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('prompt_template_active'))`)
}

/**
 * Create a new prompt template set version and insert its entries. History is
 * append-only: prior sets are never mutated, only deactivated when the new
 * version takes over as active. Callers MUST run this inside `transaction`.
 */
export async function createPromptTemplateSetWithEntries(
  client: pg.PoolClient,
  input: {
    name?: string
    activate?: boolean
    createdBy?: string | null
    entries: PromptTemplateEntryInput[]
  },
): Promise<PromptTemplateSetWithEntries> {
  const setName = (input.name?.trim() || 'default')
  const activate = input.activate ?? true
  const createdBy = input.createdBy || null
  if (input.entries.length === 0 || input.entries.length > PROMPT_TEMPLATE_MAX_ENTRIES) {
    throw new Error('INVALID_INPUT')
  }


  if (activate) await lockPromptTemplateActiveSwap(client)
  await lockPromptTemplateVersion(client, setName)
  const versionRes = await client.query(
    `SELECT COALESCE(MAX(version), 0)::int AS v
     FROM prompt_template_sets
     WHERE name = $1`,
    [setName],
  )
  const version = Number(versionRes.rows[0]?.v ?? 0) + 1

  const normalized = input.entries.map((entry, index) => ({
    name: entry.name.trim(),
    description: entry.description?.trim() || '',
    instruction: entry.instruction,
    path: entry.path?.trim() || `${entry.name.trim()}.md`,
    sortOrder: entry.sortOrder ?? index,
  }))
  const names = new Set<string>()
  for (const entry of normalized) {
    if (!entry.name) throw new Error('TEMPLATE_NAME_EMPTY')
    if (!entry.instruction.trim()) throw new Error('TEMPLATE_INSTRUCTION_EMPTY')
    if (names.has(entry.name)) throw new Error('DUPLICATE_TEMPLATE_NAME')
    assertValidSortOrder(entry.sortOrder)
    names.add(entry.name)
  }
  const digest = computePromptTemplateDigest(normalized)

  const setRes = await client.query(
    `INSERT INTO prompt_template_sets(
       name, version, is_active, index_path, entry_count, content_digest, created_by
     )
     VALUES ($1, $2, false, 'db', $3, $4, $5)
     RETURNING *`,
    [setName, version, normalized.length, digest, createdBy],
  )
  const setRow = setRes.rows[0] as PromptTemplateSetRow
  const setId = setRow.id

  const insertedEntries: PromptTemplateEntryEntity[] = []
  for (const entry of normalized) {
    const sha = promptTemplateEntrySha256(entry.instruction)
    const entryRes = await client.query(
      `INSERT INTO prompt_template_entries(
         set_id, name, description, path, content_sha256, instruction, sort_order
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [setId, entry.name, entry.description, entry.path, sha, entry.instruction, entry.sortOrder],
    )
    insertedEntries.push(toPromptTemplateEntryEntity(entryRes.rows[0] as PromptTemplateEntryRow))
  }

  let isActive = false
  if (activate) {
    await client.query(`UPDATE prompt_template_sets SET is_active = false WHERE is_active = true`)
    await client.query(`UPDATE prompt_template_sets SET is_active = true, updated_at = now() WHERE id = $1`, [setId])
    setRow.is_active = true
    isActive = true
  }

  if (isActive) {
    await bumpConfigRevision(client)
  }

  return {
    ...toPromptTemplateSetEntity(setRow),
    entries: insertedEntries,
  }
}

/**
 * Activate a specific prompt template set by UUID.
 */
export async function activatePromptTemplateSet(
  client: pg.PoolClient,
  setId: string,
): Promise<PromptTemplateSetEntity | null> {
  await lockPromptTemplateActiveSwap(client)
  const locked = await client.query(
    `SELECT * FROM prompt_template_sets WHERE id = $1 FOR UPDATE`,
    [setId],
  )
  if (!locked.rows[0]) return null
  await client.query(`UPDATE prompt_template_sets SET is_active = false WHERE is_active = true`)
  const res = await client.query(
    `UPDATE prompt_template_sets
     SET is_active = true, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [setId],
  )
  await bumpConfigRevision(client)
  return toPromptTemplateSetEntity(res.rows[0] as PromptTemplateSetRow)
}

/**
 * Delete an inactive prompt template set. Active sets cannot be deleted.
 */
export async function deletePromptTemplateSet(
  client: pg.PoolClient,
  setId: string,
): Promise<{ deleted: boolean; error?: string }> {
  await lockPromptTemplateActiveSwap(client)
  const locked = await client.query(
    `SELECT * FROM prompt_template_sets WHERE id = $1 FOR UPDATE`,
    [setId],
  )
  if (!locked.rows[0]) return { deleted: false, error: 'TEMPLATE_SET_NOT_FOUND' }
  const existing = toPromptTemplateSetEntity(locked.rows[0] as PromptTemplateSetRow)
  if (existing.isActive) return { deleted: false, error: 'CANNOT_DELETE_ACTIVE_SET' }

  await client.query(`DELETE FROM prompt_template_sets WHERE id = $1`, [setId])
  return { deleted: true }
}

interface ForkedEntry {
  name: string
  description: string
  instruction: string
  path: string
  sortOrder: number
}

function toForkedEntry(entity: PromptTemplateEntryEntity): ForkedEntry {
  return {
    name: entity.name,
    description: entity.description,
    instruction: entity.instruction ?? '',
    path: entity.path,
    sortOrder: entity.sortOrder,
  }
}

/**
 * Fork a source set into a new version carrying `nextEntries`. The source set
 * row and its entries are never updated or deleted (except deactivating a
 * previously active source when the fork preserves active status). The new
 * version always refreshes `entry_count`/`content_digest`; a newly active
 * version additionally bumps the onboarding config revision. Callers MUST run
 * this inside `transaction` and MUST already hold the active advisory lock
 * (taken before the source row was locked `FOR UPDATE`); this function only
 * takes the per-name version lock, preserving the global order
 * active advisory -> set row FOR UPDATE -> version advisory.
 */
async function forkPromptTemplateSet(
  client: pg.PoolClient,
  source: PromptTemplateSetEntity,
  nextEntries: ForkedEntry[],
  createdBy?: string | null,
): Promise<PromptTemplateSetWithEntries> {
  if (nextEntries.length === 0 || nextEntries.length > PROMPT_TEMPLATE_MAX_ENTRIES) {
    throw new Error('INVALID_INPUT')
  }
  const seen = new Set<string>()
  for (const entry of nextEntries) {
    if (seen.has(entry.name)) throw new Error('DUPLICATE_TEMPLATE_NAME')
    assertValidSortOrder(entry.sortOrder)
    seen.add(entry.name)
  }

  await lockPromptTemplateVersion(client, source.name)
  const versionRes = await client.query(
    `SELECT COALESCE(MAX(version), 0)::int AS v
     FROM prompt_template_sets
     WHERE name = $1`,
    [source.name],
  )
  const version = Number(versionRes.rows[0]?.v ?? 0) + 1
  const digest = computePromptTemplateDigest(nextEntries)

  const setRes = await client.query(
    `INSERT INTO prompt_template_sets(
       name, version, is_active, index_path, entry_count, content_digest, created_by
     )
     VALUES ($1, $2, false, 'db', $3, $4, $5)
     RETURNING *`,
    [source.name, version, nextEntries.length, digest, createdBy || null],
  )
  const setRow = setRes.rows[0] as PromptTemplateSetRow
  const newSetId = setRow.id

  const insertedEntries: PromptTemplateEntryEntity[] = []
  for (const entry of nextEntries) {
    const sha = promptTemplateEntrySha256(entry.instruction)
    const entryRes = await client.query(
      `INSERT INTO prompt_template_entries(
         set_id, name, description, path, content_sha256, instruction, sort_order
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [newSetId, entry.name, entry.description, entry.path, sha, entry.instruction, entry.sortOrder],
    )
    insertedEntries.push(toPromptTemplateEntryEntity(entryRes.rows[0] as PromptTemplateEntryRow))
  }
  let isActive = false
  if (source.isActive) {
    await client.query(`UPDATE prompt_template_sets SET is_active = false WHERE is_active = true`)
    await client.query(`UPDATE prompt_template_sets SET is_active = true, updated_at = now() WHERE id = $1`, [newSetId])
    setRow.is_active = true
    isActive = true
  }

  if (isActive) {
    await bumpConfigRevision(client)
  }

  return {
    ...toPromptTemplateSetEntity(setRow),
    entries: insertedEntries,
  }
}

async function loadSourceSetForFork(
  client: pg.PoolClient,
  setId: string,
): Promise<{ source: PromptTemplateSetEntity; entries: PromptTemplateEntryEntity[] } | null> {
  const setRes = await client.query(
    `SELECT * FROM prompt_template_sets WHERE id = $1 FOR UPDATE`,
    [setId],
  )
  if (!setRes.rows[0]) return null
  const source = toPromptTemplateSetEntity(setRes.rows[0] as PromptTemplateSetRow)
  const entriesRes = await client.query(
    `SELECT * FROM prompt_template_entries
     WHERE set_id = $1
     ORDER BY sort_order ASC, name ASC`,
    [setId],
  )
  const entries = (entriesRes.rows as PromptTemplateEntryRow[]).map(toPromptTemplateEntryEntity)
  return { source, entries }
}

/**
 * Copy-on-write entry create: forks the source set into a new version that
 * carries every historical entry plus the new one. Active status is preserved
 * (an active source yields an active fork). Never mutates historical rows.
 */
export async function createPromptTemplateEntry(
  client: pg.PoolClient,
  setId: string,
  entry: PromptTemplateEntryInput,
  opts?: { createdBy?: string | null },
): Promise<PromptTemplateSetWithEntries> {
  await lockPromptTemplateActiveSwap(client)
  const loaded = await loadSourceSetForFork(client, setId)
  if (!loaded) throw new Error('TEMPLATE_SET_NOT_FOUND')
  if (!loaded.source.isActive) throw new Error('TEMPLATE_SET_NOT_ACTIVE')
  const trimmedName = entry.name.trim()
  if (loaded.entries.some((existing) => existing.name === trimmedName)) {
    throw new Error('DUPLICATE_TEMPLATE_NAME')
  }
  const maxSort = loaded.entries.reduce((max, existing) => Math.max(max, existing.sortOrder), -1)
  const nextEntries = [
    ...loaded.entries.map(toForkedEntry),
    {
      name: trimmedName,
      description: entry.description?.trim() || '',
      instruction: entry.instruction,
      sortOrder: entry.sortOrder ?? Math.min(maxSort + 1, PROMPT_TEMPLATE_MAX_SORT_ORDER),
      path: entry.path?.trim() || `${trimmedName}.md`,
    },
  ]
  return forkPromptTemplateSet(client, loaded.source, nextEntries, opts?.createdBy)
}

/**
 * Copy-on-write entry update: forks the entry's source set into a new version
 * with the patch applied to the copied row. The historical entry row is never
 * updated in place. Returns null when the entry does not exist.
 */
export async function updatePromptTemplateEntry(
  client: pg.PoolClient,
  entryId: string,
  patch: {
    name?: string
    description?: string
    instruction?: string
    sortOrder?: number
    path?: string
  },
  opts?: { createdBy?: string | null },
): Promise<PromptTemplateSetWithEntries | null> {
  await lockPromptTemplateActiveSwap(client)
  const currentRes = await client.query(
    `SELECT * FROM prompt_template_entries WHERE id = $1`,
    [entryId],
  )
  if (!currentRes.rows[0]) return null
  const current = currentRes.rows[0] as PromptTemplateEntryRow

  const loaded = await loadSourceSetForFork(client, current.set_id)
  if (!loaded) throw new Error('TEMPLATE_SET_NOT_FOUND')
  if (!loaded.source.isActive) throw new Error('TEMPLATE_SET_NOT_ACTIVE')

  const nextName = patch.name !== undefined ? patch.name.trim() : current.name
  if (
    nextName !== current.name &&
    loaded.entries.some((existing) => existing.name === nextName && existing.id !== entryId)
  ) {
    throw new Error('DUPLICATE_TEMPLATE_NAME')
  }

  const nextEntries = loaded.entries.map((existing) => {
    if (existing.id !== entryId) return toForkedEntry(existing)
    return {
      name: nextName,
      description: patch.description !== undefined ? patch.description.trim() : existing.description,
      instruction: patch.instruction !== undefined ? patch.instruction : (existing.instruction ?? ''),
      path: patch.path !== undefined ? patch.path.trim() : existing.path,
      sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : existing.sortOrder,
    }
  })
  return forkPromptTemplateSet(client, loaded.source, nextEntries, opts?.createdBy)
}

/**
 * Copy-on-write entry delete: forks the entry's source set into a new version
 * without the deleted row. The historical row stays intact on the old version;
 * only the fork omits it. The fork must keep at least one template.
 */
export async function deletePromptTemplateEntry(
  client: pg.PoolClient,
  entryId: string,
  opts?: { createdBy?: string | null },
): Promise<{ deleted: boolean; setId?: string; newSetId?: string }> {
  await lockPromptTemplateActiveSwap(client)
  const currentRes = await client.query(
    `SELECT * FROM prompt_template_entries WHERE id = $1`,
    [entryId],
  )
  if (!currentRes.rows[0]) return { deleted: false }
  const current = currentRes.rows[0] as PromptTemplateEntryRow

  const loaded = await loadSourceSetForFork(client, current.set_id)
  if (!loaded) return { deleted: false }
  if (!loaded.source.isActive) throw new Error('TEMPLATE_SET_NOT_ACTIVE')
  const nextEntries = loaded.entries
    .filter((existing) => existing.id !== entryId)
    .map(toForkedEntry)
  if (nextEntries.length === 0) throw new Error('INVALID_INPUT')

  const forked = await forkPromptTemplateSet(client, loaded.source, nextEntries, opts?.createdBy)
  return { deleted: true, setId: forked.id, newSetId: forked.id }
}
