import assert from 'node:assert/strict'
import test from 'node:test'
import type pg from 'pg'
import {
  createModelConfigRevision,
  getLatestModelConfigRevision,
  getModelConfigRevisionById,
  type ModelConfigRevisionRow,
} from './repositories/model-config-revisions'
import {
  createProviderRun,
  updateProviderRunState,
  acquireWorkerLease,
  releaseWorkerLease,
  countActiveReservedRuns,
  acquireModelCapacity,
  type ProviderRunRow,
} from './repositories/provider-runs'
import {
  registerOutputIngestion,
  updateOutputIngestion,
  getOutputIngestionsByJob,
  type OutputIngestionRow,
} from './repositories/output-ingestions'

test('model_config_revisions repository creates and retrieves revisions with immutable provider details', async () => {
  const revisions: ModelConfigRevisionRow[] = []
  const mockClient = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT COALESCE(MAX(revision)')) {
        const modelId = params[0] as string
        const revs = revisions.filter(r => r.model_id === modelId).map(r => r.revision)
        const max = revs.length ? Math.max(...revs) : 0
        return { rows: [{ next_rev: max + 1 }] }
      }
      if (sql.includes('INSERT INTO model_config_revisions')) {
        const row: ModelConfigRevisionRow = {
          id: 'rev-uuid-1',
          model_id: params[0] as string,
          revision: params[1] as number,
          provider_id: params[2] as string,
          plugin_id: params[3] as string,
          plugin_version: params[4] as string,
          vendor_model_id: (params[5] as string) || null,
          base_url: (params[6] as string) || null,
          credential_id: (params[7] as string) || null,
          credential_schema_version: (params[8] as number) || null,
          capabilities: JSON.parse(params[9] as string),
          pricing: JSON.parse(params[10] as string),
          normalized_config: JSON.parse(params[11] as string),
          defaults: JSON.parse(params[12] as string),
          snapshot_digest: params[13] as string,
          created_by: (params[14] as string) || null,
          created_at: new Date('2026-09-03T12:00:00Z'),
        }
        revisions.push(row)
        return { rows: [row] }
      }
      if (sql.includes('UPDATE model_configs SET latest_revision_id')) {
        return { rows: [] }
      }
      if (sql.replace(/\s+/g, ' ').includes('SELECT * FROM model_config_revisions WHERE model_id = $1 ORDER BY revision DESC')) {
        const modelId = params[0] as string
        const filtered = revisions.filter(r => r.model_id === modelId).sort((a, b) => b.revision - a.revision)
        return { rows: filtered.slice(0, 1) }
      }
      if (sql.includes('SELECT * FROM model_config_revisions WHERE id = $1')) {
        const id = params[0] as string
        const found = revisions.find(r => r.id === id)
        return { rows: found ? [found] : [] }
      }
      return { rows: [] }
    },
  } as unknown as pg.PoolClient

  const created = await createModelConfigRevision(mockClient, {
    modelId: 'model-1',
    providerId: 'volcengine',
    pluginId: 'seedream-image',
    vendorModelId: 'ep-seedream-1',
    capabilities: { mediaKind: 'image', modes: ['text_to_image'] },
    pricing: { scheme: 'per_image_v1', creditsPerImage: 10 },
    snapshotDigest: 'sha256-hash',
  })

  assert.equal(created.revision, 1)
  assert.equal(created.providerId, 'volcengine')
  assert.equal(created.pluginId, 'seedream-image')
  assert.equal(created.vendorModelId, 'ep-seedream-1')
  assert.equal(created.capabilities.mediaKind, 'image')

  const latest = await getLatestModelConfigRevision(mockClient, 'model-1')
  assert.ok(latest)
  assert.equal(latest?.revision, 1)
  assert.equal(latest?.snapshotDigest, 'sha256-hash')

  const byId = await getModelConfigRevisionById(mockClient, 'rev-uuid-1')
  assert.ok(byId)
  assert.equal(byId?.id, 'rev-uuid-1')
})

test('provider_runs repository handles lifecycle transitions, submission_unknown/importing, capacity lifecycle and worker lease', async () => {
  const runs: Record<string, ProviderRunRow> = {}

  const mockClient = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO provider_runs')) {
        const token = params[5] as string
        const existing = Object.values(runs).find(r => r.client_token === token)
        if (existing) {
          existing.updated_at = new Date()
          return { rows: [existing] }
        }
        const capacityState = params[9] as ProviderRunRow['capacity_state']
        const row: ProviderRunRow = {
          id: 'run-1',
          job_id: params[0] as string,
          attempt: params[1] as number,
          provider_id: params[2] as string,
          plugin_id: params[3] as string,
          plugin_version: params[4] as string,
          client_token: token,
          remote_id: (params[6] as string) || null,
          operation_state: params[7] as ProviderRunRow['operation_state'],
          next_action_at: (params[8] as Date) || null,
          capacity_state: capacityState,
          capacity_reservation_id: (params[10] as string) || null,
          capacity_reserved_at: capacityState === 'reserved' ? new Date() : null,
          capacity_released_at: null,
          state_revision: 1,
          worker_lease_token: null,
          worker_lease_expires_at: null,
          encrypted_state_payload: null,
          encrypted_state_key_id: null,
          output_manifest: null,
          error: null,
          submitted_at: new Date(),
          provider_accepted_at: null,
          completed_at: null,
          created_at: new Date('2026-09-03T12:00:00Z'),
          updated_at: new Date('2026-09-03T12:00:00Z'),
        }
        runs[row.id] = row
        return { rows: [row] }
      }
      if (sql.includes('SELECT * FROM provider_runs WHERE client_token = $1')) {
        const token = params[0] as string
        const found = Object.values(runs).find(r => r.client_token === token)
        return { rows: found ? [found] : [] }
      }
      if (sql.includes('UPDATE provider_runs') && sql.includes('state_revision = state_revision + 1')) {
        const runId = params[0] as string
        const expectedRev = params[1] as number
        const run = runs[runId]
        if (!run || run.state_revision !== expectedRev) return { rows: [] }

        run.state_revision += 1
        run.updated_at = new Date()
        if (sql.includes('operation_state =')) {
          const idx = sql.split('operation_state = $')[1]?.charAt(0)
          if (idx) run.operation_state = params[parseInt(idx, 10) - 1] as ProviderRunRow['operation_state']
        }
        if (sql.includes('remote_id =')) {
          const idx = sql.split('remote_id = $')[1]?.charAt(0)
          if (idx) run.remote_id = params[parseInt(idx, 10) - 1] as string
        }
        if (sql.includes('provider_accepted_at = COALESCE')) {
          run.provider_accepted_at = new Date()
        }
        if (sql.includes("capacity_state = 'released'")) {
          run.capacity_state = 'released'
          run.capacity_released_at = new Date()
        }
        return { rows: [run] }
      }
      if (sql.includes('worker_lease_token = $2')) {
        const runId = params[0] as string
        const leaseToken = params[1] as string
        const run = runs[runId]
        if (!run) return { rows: [] }
        run.worker_lease_token = leaseToken
        run.worker_lease_expires_at = new Date(Date.now() + 30000)
        return { rows: [run] }
      }
      if (sql.includes('worker_lease_token = NULL')) {
        const runId = params[0] as string
        const leaseToken = params[1] as string
        const run = runs[runId]
        if (!run || run.worker_lease_token !== leaseToken) return { rows: [] }
        run.worker_lease_token = null
        run.worker_lease_expires_at = null
        return { rows: [{ id: runId }] }
      }
      if (sql.includes("WHERE provider_id = $1") && sql.includes("capacity_state = 'reserved'")) {
        const pId = params[0] as string
        const active = Object.values(runs).filter(
          r => r.provider_id === pId && r.capacity_state === 'reserved' && !['succeeded', 'failed', 'canceled'].includes(r.operation_state)
        )
        return { rows: [{ count: active.length }] }
      }
      return { rows: [] }
    },
  } as unknown as pg.PoolClient

  const run = await createProviderRun(mockClient, {
    jobId: 'job-1',
    attempt: 1,
    providerId: 'volcengine',
    pluginId: 'seedance-video',
    clientToken: 'token-abc',
    capacityState: 'reserved',
    capacityReservationId: 'cap-res-1',
  })
  assert.equal(run.id, 'run-1')
  assert.equal(run.providerId, 'volcengine')
  assert.equal(run.operationState, 'submitting')
  assert.equal(run.stateRevision, 1)
  assert.equal(run.capacityState, 'reserved')
  assert.equal(run.capacityReservationId, 'cap-res-1')

  // Check active reserved runs count
  const activeCount = await countActiveReservedRuns(mockClient, 'volcengine')
  assert.equal(activeCount, 1)

  // Optimistic concurrency update to waiting with provider acceptance
  const updated = await updateProviderRunState(mockClient, {
    runId: 'run-1',
    expectedStateRevision: 1,
    operationState: 'waiting',
    remoteId: 'remote-task-123',
    providerAccepted: true,
  })
  assert.ok(updated)
  assert.equal(updated?.stateRevision, 2)
  assert.equal(updated?.remoteId, 'remote-task-123')
  assert.equal(updated?.operationState, 'waiting')

  // Update to importing
  const importing = await updateProviderRunState(mockClient, {
    runId: 'run-1',
    expectedStateRevision: 2,
    operationState: 'importing',
  })
  assert.ok(importing)
  assert.equal(importing?.operationState, 'importing')

  // Release capacity on completion
  const releasedCapacity = await updateProviderRunState(mockClient, {
    runId: 'run-1',
    expectedStateRevision: 3,
    releaseCapacity: true,
  })
  assert.ok(releasedCapacity)
  assert.equal(releasedCapacity?.capacityState, 'released')

  // Lease acquisition and release
  const leased = await acquireWorkerLease(mockClient, {
    runId: 'run-1',
    leaseToken: 'worker-a',
  })
  assert.ok(leased)
  assert.equal(leased?.workerLeaseToken, 'worker-a')

  const released = await releaseWorkerLease(mockClient, 'run-1', 'worker-a')
  assert.equal(released, true)
})

test('acquireModelCapacity atomically acquires capacity against model concurrency limit', async () => {
  const runs: Record<string, ProviderRunRow> = {}
  const mockClient = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM model_configs WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ id: params[0], concurrency_limit: 2, provider_id: 'volcengine', plugin_id: 'seedance-video' }] }
      }
      if (sql.includes("FROM provider_runs pr") && sql.includes("JOIN generation_jobs gj") && sql.includes("gj.model_id = $1")) {
        const mId = params[0] as string
        const active = Object.values(runs).filter(
          r => r.job_id.startsWith(mId === 'm1' ? 'j' : 'other') && r.capacity_state === 'reserved' && !['succeeded', 'failed', 'canceled'].includes(r.operation_state)
        )
        return { rows: [{ count: active.length }] }
      }
      if (sql.includes('INSERT INTO provider_runs')) {
        const token = params[5] as string
        const row: ProviderRunRow = {
          id: `run-${Object.keys(runs).length + 1}`,
          job_id: params[0] as string,
          attempt: params[1] as number,
          provider_id: params[2] as string,
          plugin_id: params[3] as string,
          plugin_version: params[4] as string,
          client_token: token,
          remote_id: null,
          operation_state: 'submitting',
          next_action_at: null,
          capacity_state: 'reserved',
          capacity_reservation_id: (params[10] as string) || null,
          capacity_reserved_at: new Date(),
          capacity_released_at: null,
          state_revision: 1,
          worker_lease_token: null,
          worker_lease_expires_at: null,
          encrypted_state_payload: null,
          encrypted_state_key_id: null,
          output_manifest: null,
          error: null,
          submitted_at: new Date(),
          provider_accepted_at: null,
          completed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        }
        runs[row.id] = row
        return { rows: [row] }
      }
      return { rows: [] }
    },
  } as unknown as pg.PoolClient

  const acq1 = await acquireModelCapacity(mockClient, {
    modelId: 'm1',
    providerId: 'volcengine',
    pluginId: 'seedance-video',
    clientToken: 'token-1',
    jobId: 'j1',
  })
  assert.equal(acq1.acquired, true)
  assert.equal(acq1.activeCount, 1)

  const acq2 = await acquireModelCapacity(mockClient, {
    modelId: 'm1',
    providerId: 'volcengine',
    pluginId: 'seedance-video',
    clientToken: 'token-2',
    jobId: 'j2',
  })
  assert.equal(acq2.acquired, true)
  assert.equal(acq2.activeCount, 2)

  // Third attempt should fail because limit is 2
  const acq3 = await acquireModelCapacity(mockClient, {
    modelId: 'm1',
    providerId: 'volcengine',
    pluginId: 'seedance-video',
    clientToken: 'token-3',
    jobId: 'j3',
  })
  assert.equal(acq3.acquired, false)
  assert.equal(acq3.reason, 'CONCURRENCY_LIMIT_EXCEEDED')
})

test('output_ingestions repository registers and updates crash-safe output artifacts without plain remote_url', async () => {
  const ingestions: Record<string, OutputIngestionRow> = {}

  const mockClient = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO output_ingestions')) {
        const row: OutputIngestionRow = {
          id: 'ingest-1',
          job_id: params[0] as string,
          run_id: params[1] as string,
          output_index: params[2] as number,
          media_kind: params[3] as 'image' | 'video',
          storage_object_key: params[4] as string,
          multipart_upload_id: null,
          checksum: null,
          size_bytes: null,
          mime_type: null,
          ingestion_state: 'pending',
          asset_id: null,
          metadata: JSON.parse(params[5] as string),
          error: null,
          download_started_at: null,
          download_completed_at: null,
          attached_at: null,
          created_at: new Date('2026-09-03T12:00:00Z'),
          updated_at: new Date('2026-09-03T12:00:00Z'),
        }
        ingestions[row.id] = row
        return { rows: [row] }
      }
      if (sql.includes('UPDATE output_ingestions')) {
        const id = params[0] as string
        const item = ingestions[id]
        if (!item) return { rows: [] }
        item.updated_at = new Date()
        if (sql.includes('ingestion_state =')) item.ingestion_state = 'persisted'
        if (sql.includes('checksum =')) item.checksum = 'sha256-abc'
        if (sql.includes('size_bytes =')) item.size_bytes = 1048576
        if (sql.includes('asset_id =')) item.asset_id = 'asset-uuid-1'
        if (sql.includes('attached_at = COALESCE')) item.attached_at = new Date()
        return { rows: [item] }
      }
      if (sql.includes('SELECT * FROM output_ingestions WHERE job_id = $1')) {
        const jobId = params[0] as string
        const list = Object.values(ingestions).filter(i => i.job_id === jobId)
        return { rows: list }
      }
      return { rows: [] }
    },
  } as unknown as pg.PoolClient

  const registered = await registerOutputIngestion(mockClient, {
    jobId: 'job-1',
    runId: 'run-1',
    outputIndex: 0,
    mediaKind: 'video',
    storageObjectKey: 'users/u1/jobs/j1/output_0.mp4',
  })

  assert.equal(registered.id, 'ingest-1')
  assert.equal(registered.mediaKind, 'video')
  assert.equal(registered.ingestionState, 'pending')
  assert.equal(registered.storageObjectKey, 'users/u1/jobs/j1/output_0.mp4')

  const updated = await updateOutputIngestion(mockClient, {
    id: 'ingest-1',
    ingestionState: 'persisted',
    checksum: 'sha256-abc',
    sizeBytes: 1048576,
    assetId: 'asset-uuid-1',
    attached: true,
  })

  assert.ok(updated)
  assert.equal(updated?.ingestionState, 'persisted')
  assert.equal(updated?.assetId, 'asset-uuid-1')

  const jobIngestions = await getOutputIngestionsByJob(mockClient, 'job-1')
  assert.equal(jobIngestions.length, 1)
})
