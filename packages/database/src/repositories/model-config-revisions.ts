import type pg from 'pg'

export interface ModelConfigRevisionRow {
  id: string
  model_id: string
  revision: number
  provider_id: string
  plugin_id: string
  plugin_version: string
  vendor_model_id?: string | null
  base_url?: string | null
  credential_id?: string | null
  credential_schema_version?: number | null
  capabilities: unknown
  pricing: unknown
  normalized_config: unknown
  defaults: unknown
  snapshot_digest: string
  created_by?: string | null
  created_at: Date
}

export interface ModelConfigRevisionEntity {
  id: string
  modelId: string
  revision: number
  providerId: string
  pluginId: string
  pluginVersion: string
  vendorModelId?: string | null
  baseUrl?: string | null
  credentialId?: string | null
  credentialSchemaVersion?: number | null
  capabilities: Record<string, unknown>
  pricing: Record<string, unknown>
  normalizedConfig: Record<string, unknown>
  defaults: Record<string, unknown>
  snapshotDigest: string
  createdBy?: string | null
  createdAt: string
}

export function toModelConfigRevisionEntity(row: ModelConfigRevisionRow): ModelConfigRevisionEntity {
  return {
    id: row.id,
    modelId: row.model_id,
    revision: Number(row.revision),
    providerId: row.provider_id,
    pluginId: row.plugin_id,
    pluginVersion: row.plugin_version,
    vendorModelId: row.vendor_model_id ?? null,
    baseUrl: row.base_url ?? null,
    credentialId: row.credential_id ?? null,
    credentialSchemaVersion: row.credential_schema_version ? Number(row.credential_schema_version) : null,
    capabilities: (row.capabilities as Record<string, unknown>) || {},
    pricing: (row.pricing as Record<string, unknown>) || {},
    normalizedConfig: (row.normalized_config as Record<string, unknown>) || {},
    defaults: (row.defaults as Record<string, unknown>) || {},
    snapshotDigest: row.snapshot_digest,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

export interface CreateModelConfigRevisionInput {
  modelId: string
  providerId: string
  pluginId: string
  pluginVersion?: string
  vendorModelId?: string | null
  baseUrl?: string | null
  credentialId?: string | null
  credentialSchemaVersion?: number | null
  capabilities: Record<string, unknown>
  pricing: Record<string, unknown>
  normalizedConfig?: Record<string, unknown>
  defaults?: Record<string, unknown>
  snapshotDigest: string
  createdBy?: string | null
}

export async function createModelConfigRevision(
  client: pg.PoolClient | pg.Pool,
  input: CreateModelConfigRevisionInput,
): Promise<ModelConfigRevisionEntity> {
  const nextRevRes = await client.query(
    'SELECT COALESCE(MAX(revision), 0) + 1 AS next_rev FROM model_config_revisions WHERE model_id = $1',
    [input.modelId],
  )
  const nextRevision = Number(nextRevRes.rows[0]?.next_rev || 1)

  const res = await client.query(
    `INSERT INTO model_config_revisions(
       model_id, revision, provider_id, plugin_id, plugin_version,
       vendor_model_id, base_url, credential_id, credential_schema_version,
       capabilities, pricing, normalized_config, defaults, snapshot_digest, created_by
     ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      input.modelId,
      nextRevision,
      input.providerId,
      input.pluginId,
      input.pluginVersion || '1.0.0',
      input.vendorModelId || null,
      input.baseUrl || null,
      input.credentialId || null,
      input.credentialSchemaVersion || null,
      JSON.stringify(input.capabilities || {}),
      JSON.stringify(input.pricing || {}),
      JSON.stringify(input.normalizedConfig || {}),
      JSON.stringify(input.defaults || {}),
      input.snapshotDigest,
      input.createdBy || null,
    ],
  )

  const row = res.rows[0] as ModelConfigRevisionRow
  await client.query(
    'UPDATE model_configs SET latest_revision_id = $1, updated_at = now() WHERE id = $2',
    [row.id, input.modelId],
  )

  return toModelConfigRevisionEntity(row)
}

export async function getLatestModelConfigRevision(
  client: pg.PoolClient | pg.Pool,
  modelId: string,
): Promise<ModelConfigRevisionEntity | null> {
  const res = await client.query(
    `SELECT * FROM model_config_revisions
     WHERE model_id = $1
     ORDER BY revision DESC
     LIMIT 1`,
    [modelId],
  )
  if (!res.rows[0]) return null
  return toModelConfigRevisionEntity(res.rows[0] as ModelConfigRevisionRow)
}

export async function getModelConfigRevisionById(
  client: pg.PoolClient | pg.Pool,
  revisionId: string,
): Promise<ModelConfigRevisionEntity | null> {
  const res = await client.query(
    'SELECT * FROM model_config_revisions WHERE id = $1',
    [revisionId],
  )
  if (!res.rows[0]) return null
  return toModelConfigRevisionEntity(res.rows[0] as ModelConfigRevisionRow)
}

export async function getModelConfigRevisionByNumber(
  client: pg.PoolClient | pg.Pool,
  modelId: string,
  revision: number,
): Promise<ModelConfigRevisionEntity | null> {
  const res = await client.query(
    'SELECT * FROM model_config_revisions WHERE model_id = $1 AND revision = $2',
    [modelId, revision],
  )
  if (!res.rows[0]) return null
  return toModelConfigRevisionEntity(res.rows[0] as ModelConfigRevisionRow)
}
