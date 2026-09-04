import type pg from 'pg'

export type ProviderRunOperationState =
  | 'submitting'
  | 'submission_unknown'
  | 'waiting'
  | 'importing'
  | 'canceling'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export type ProviderRunCapacityState =
  | 'pending'
  | 'reserved'
  | 'released'

export interface ProviderRunRow {
  id: string
  job_id: string
  attempt: number
  provider_id: string
  plugin_id: string
  plugin_version: string
  operation_state: ProviderRunOperationState
  client_token: string
  remote_id: string | null
  state_revision: number
  next_action_at: Date | null
  capacity_state: ProviderRunCapacityState
  capacity_reservation_id: string | null
  capacity_reserved_at: Date | null
  capacity_released_at: Date | null
  worker_lease_token: string | null
  worker_lease_expires_at: Date | null
  encrypted_state_payload: string | null
  encrypted_state_key_id: string | null
  output_manifest: unknown
  error: unknown
  submitted_at: Date | null
  provider_accepted_at: Date | null
  completed_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface ProviderRunEntity {
  id: string
  jobId: string
  attempt: number
  providerId: string
  pluginId: string
  pluginVersion: string
  operationState: ProviderRunOperationState
  clientToken: string
  remoteId: string | null
  stateRevision: number
  nextActionAt: string | null
  capacityState: ProviderRunCapacityState
  capacityReservationId: string | null
  capacityReservedAt: string | null
  capacityReleasedAt: string | null
  workerLeaseToken: string | null
  workerLeaseExpiresAt: string | null
  encryptedStatePayload: string | null
  encryptedStateKeyId: string | null
  outputManifest: Record<string, unknown> | null
  error: { code: string; message: string; retryable?: boolean; details?: unknown } | null
  submittedAt: string | null
  providerAcceptedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export function toProviderRunEntity(row: ProviderRunRow): ProviderRunEntity {
  return {
    id: row.id,
    jobId: row.job_id,
    attempt: Number(row.attempt),
    providerId: row.provider_id,
    pluginId: row.plugin_id,
    pluginVersion: row.plugin_version,
    operationState: row.operation_state,
    clientToken: row.client_token,
    remoteId: row.remote_id ?? null,
    stateRevision: Number(row.state_revision),
    nextActionAt: row.next_action_at instanceof Date ? row.next_action_at.toISOString() : (row.next_action_at ? String(row.next_action_at) : null),
    capacityState: row.capacity_state,
    capacityReservationId: row.capacity_reservation_id ?? null,
    capacityReservedAt: row.capacity_reserved_at instanceof Date ? row.capacity_reserved_at.toISOString() : (row.capacity_reserved_at ? String(row.capacity_reserved_at) : null),
    capacityReleasedAt: row.capacity_released_at instanceof Date ? row.capacity_released_at.toISOString() : (row.capacity_released_at ? String(row.capacity_released_at) : null),
    workerLeaseToken: row.worker_lease_token ?? null,
    workerLeaseExpiresAt: row.worker_lease_expires_at instanceof Date ? row.worker_lease_expires_at.toISOString() : (row.worker_lease_expires_at ? String(row.worker_lease_expires_at) : null),
    encryptedStatePayload: row.encrypted_state_payload ?? null,
    encryptedStateKeyId: row.encrypted_state_key_id ?? null,
    outputManifest: (row.output_manifest as Record<string, unknown>) || null,
    error: (row.error as { code: string; message: string; retryable?: boolean; details?: unknown }) || null,
    submittedAt: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : (row.submitted_at ? String(row.submitted_at) : null),
    providerAcceptedAt: row.provider_accepted_at instanceof Date ? row.provider_accepted_at.toISOString() : (row.provider_accepted_at ? String(row.provider_accepted_at) : null),
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : (row.completed_at ? String(row.completed_at) : null),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}

export interface CreateProviderRunInput {
  jobId: string
  attempt?: number
  providerId: string
  pluginId: string
  pluginVersion?: string
  clientToken: string
  remoteId?: string | null
  operationState?: ProviderRunOperationState
  nextActionAt?: Date | string | null
  capacityState?: ProviderRunCapacityState
  capacityReservationId?: string | null
}

export async function createProviderRun(
  client: pg.PoolClient | pg.Pool,
  input: CreateProviderRunInput,
): Promise<ProviderRunEntity> {
  const attempt = input.attempt ?? 1
  const capacityState = input.capacityState || (input.capacityReservationId ? 'reserved' : 'pending')
  const res = await client.query(
    `INSERT INTO provider_runs(
       job_id, attempt, provider_id, plugin_id, plugin_version, client_token, remote_id,
       operation_state, next_action_at, capacity_state, capacity_reservation_id,
       capacity_reserved_at, submitted_at
     ) VALUES(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       CASE WHEN $10 = 'reserved' THEN now() ELSE NULL END,
       now()
     )
     ON CONFLICT (client_token) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [
      input.jobId,
      attempt,
      input.providerId,
      input.pluginId,
      input.pluginVersion || '1.0.0',
      input.clientToken,
      input.remoteId || null,
      input.operationState || 'submitting',
      input.nextActionAt ? new Date(input.nextActionAt) : null,
      capacityState,
      input.capacityReservationId || null,
    ],
  )
  return toProviderRunEntity(res.rows[0] as ProviderRunRow)
}

export async function getProviderRunById(
  client: pg.PoolClient | pg.Pool,
  runId: string,
): Promise<ProviderRunEntity | null> {
  const res = await client.query('SELECT * FROM provider_runs WHERE id = $1', [runId])
  if (!res.rows[0]) return null
  return toProviderRunEntity(res.rows[0] as ProviderRunRow)
}

export async function getProviderRunByClientToken(
  client: pg.PoolClient | pg.Pool,
  clientToken: string,
): Promise<ProviderRunEntity | null> {
  const res = await client.query('SELECT * FROM provider_runs WHERE client_token = $1', [clientToken])
  if (!res.rows[0]) return null
  return toProviderRunEntity(res.rows[0] as ProviderRunRow)
}

export async function getLatestProviderRunForJob(
  client: pg.PoolClient | pg.Pool,
  jobId: string,
): Promise<ProviderRunEntity | null> {
  const res = await client.query(
    'SELECT * FROM provider_runs WHERE job_id = $1 ORDER BY attempt DESC LIMIT 1',
    [jobId],
  )
  if (!res.rows[0]) return null
  return toProviderRunEntity(res.rows[0] as ProviderRunRow)
}

export interface UpdateProviderRunStateInput {
  runId: string
  expectedStateRevision: number
  operationState?: ProviderRunOperationState
  remoteId?: string | null
  nextActionAt?: Date | string | null
  capacityState?: ProviderRunCapacityState
  capacityReservationId?: string | null
  releaseCapacity?: boolean
  encryptedStatePayload?: string | null
  encryptedStateKeyId?: string | null
  outputManifest?: Record<string, unknown> | null
  error?: { code: string; message: string; retryable?: boolean; details?: unknown } | null
  providerAccepted?: boolean
  completed?: boolean
}

export async function updateProviderRunState(
  client: pg.PoolClient | pg.Pool,
  input: UpdateProviderRunStateInput,
): Promise<ProviderRunEntity | null> {
  const updates: string[] = [
    'state_revision = state_revision + 1',
    'updated_at = now()',
  ]
  const values: unknown[] = [input.runId, input.expectedStateRevision]

  if (input.operationState !== undefined) {
    values.push(input.operationState)
    updates.push(`operation_state = $${values.length}`)
  }
  if (input.remoteId !== undefined) {
    values.push(input.remoteId)
    updates.push(`remote_id = $${values.length}`)
  }
  if (input.nextActionAt !== undefined) {
    values.push(input.nextActionAt ? new Date(input.nextActionAt) : null)
    updates.push(`next_action_at = $${values.length}`)
  }
  if (input.capacityState !== undefined) {
    values.push(input.capacityState)
    updates.push(`capacity_state = $${values.length}`)
    if (input.capacityState === 'reserved') {
      updates.push('capacity_reserved_at = COALESCE(capacity_reserved_at, now())')
    } else if (input.capacityState === 'released') {
      updates.push('capacity_released_at = COALESCE(capacity_released_at, now())')
    }
  } else if (input.releaseCapacity) {
    updates.push("capacity_state = 'released'")
    updates.push('capacity_released_at = COALESCE(capacity_released_at, now())')
  }
  if (input.capacityReservationId !== undefined) {
    values.push(input.capacityReservationId)
    updates.push(`capacity_reservation_id = $${values.length}`)
  }
  if (input.encryptedStatePayload !== undefined) {
    values.push(input.encryptedStatePayload)
    updates.push(`encrypted_state_payload = $${values.length}`)
  }
  if (input.encryptedStateKeyId !== undefined) {
    values.push(input.encryptedStateKeyId)
    updates.push(`encrypted_state_key_id = $${values.length}`)
  }
  if (input.outputManifest !== undefined) {
    values.push(input.outputManifest ? JSON.stringify(input.outputManifest) : null)
    updates.push(`output_manifest = $${values.length}`)
  }
  if (input.error !== undefined) {
    values.push(input.error ? JSON.stringify(input.error) : null)
    updates.push(`error = $${values.length}`)
  }
  if (input.providerAccepted) {
    updates.push('provider_accepted_at = COALESCE(provider_accepted_at, now())')
  }
  if (input.completed) {
    updates.push('completed_at = now()')
    if (input.capacityState === undefined && !input.releaseCapacity) {
      updates.push("capacity_state = 'released'")
      updates.push('capacity_released_at = COALESCE(capacity_released_at, now())')
    }
  }

  const query = `
    UPDATE provider_runs
    SET ${updates.join(', ')}
    WHERE id = $1 AND state_revision = $2
    RETURNING *
  `
  const res = await client.query(query, values)
  if (!res.rows[0]) return null
  return toProviderRunEntity(res.rows[0] as ProviderRunRow)
}

export interface AcquireWorkerLeaseInput {
  runId: string
  leaseToken: string
  leaseDurationSeconds?: number
}

export async function acquireWorkerLease(
  client: pg.PoolClient | pg.Pool,
  input: AcquireWorkerLeaseInput,
): Promise<ProviderRunEntity | null> {
  const duration = input.leaseDurationSeconds || 30
  const res = await client.query(
    `UPDATE provider_runs
     SET worker_lease_token = $2,
         worker_lease_expires_at = now() + ($3 * interval '1 second'),
         updated_at = now()
     WHERE id = $1
       AND (worker_lease_expires_at IS NULL OR worker_lease_expires_at < now() OR worker_lease_token = $2)
     RETURNING *`,
    [input.runId, input.leaseToken, duration],
  )
  if (!res.rows[0]) return null
  return toProviderRunEntity(res.rows[0] as ProviderRunRow)
}

export async function releaseWorkerLease(
  client: pg.PoolClient | pg.Pool,
  runId: string,
  leaseToken: string,
): Promise<boolean> {
  const res = await client.query(
    `UPDATE provider_runs
     SET worker_lease_token = NULL,
         worker_lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1 AND worker_lease_token = $2
     RETURNING id`,
    [runId, leaseToken],
  )
  return Boolean(res.rows[0])
}

export async function countActiveReservedRuns(
  client: pg.PoolClient | pg.Pool,
  providerId: string,
  pluginId?: string,
): Promise<number> {
  const values: unknown[] = [providerId]
  let query = `
    SELECT count(*)::int AS count
    FROM provider_runs
    WHERE provider_id = $1
      AND capacity_state = 'reserved'
      AND operation_state NOT IN ('succeeded', 'failed', 'canceled')
  `
  if (pluginId) {
    values.push(pluginId)
    query += ` AND plugin_id = $2`
  }
  const res = await client.query(query, values)
  return Number(res.rows[0]?.count || 0)
}

export interface AcquireModelCapacityInput {
  modelId: string
  providerId: string
  pluginId: string
  clientToken: string
  jobId: string
  attempt?: number
  capacityReservationId?: string
}

export interface AcquireModelCapacityResult {
  acquired: boolean
  run?: ProviderRunEntity
  reason?: 'CONCURRENCY_LIMIT_EXCEEDED' | 'MODEL_NOT_FOUND'
  activeCount?: number
  limit?: number
}

/**
 * Atomically acquires capacity for a model execution by locking the model_configs row,
 * evaluating concurrency_limit against active reserved nonterminal provider runs for that model,
 * and creating the provider_run with capacity_state='reserved' and capacity_reserved_at=now().
 */
export async function acquireModelCapacity(
  client: pg.PoolClient,
  input: AcquireModelCapacityInput,
): Promise<AcquireModelCapacityResult> {
  const modelRes = await client.query(
    'SELECT id, concurrency_limit, provider_id, plugin_id FROM model_configs WHERE id = $1 FOR UPDATE',
    [input.modelId],
  )
  const model = modelRes.rows[0]
  if (!model) return { acquired: false, reason: 'MODEL_NOT_FOUND' }

  const limit = Number(model.concurrency_limit || 1)
  const countRes = await client.query(
    `SELECT count(*)::int AS count
     FROM provider_runs pr
     JOIN generation_jobs gj ON gj.id = pr.job_id
     WHERE gj.model_id = $1
       AND pr.capacity_state = 'reserved'
       AND pr.operation_state NOT IN ('succeeded', 'failed', 'canceled')`,
    [input.modelId],
  )
  const activeCount = Number(countRes.rows[0]?.count || 0)

  if (activeCount >= limit) {
    return {
      acquired: false,
      reason: 'CONCURRENCY_LIMIT_EXCEEDED',
      activeCount,
      limit,
    }
  }
  const reservationId = input.capacityReservationId || `cap-${input.clientToken}`
  const run = await createProviderRun(client, {
    jobId: input.jobId,
    attempt: input.attempt ?? 1,
    providerId: input.providerId,
    pluginId: input.pluginId,
    clientToken: input.clientToken,
    capacityState: 'reserved',
    capacityReservationId: reservationId,
    operationState: 'submitting',
  })

  return {
    acquired: true,
    run,
    activeCount: activeCount + 1,
    limit,
  }
}
