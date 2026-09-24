import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GenerationInputError,
  attachGenerationInputs,
  normalizeGenerationInputs,
  validateAndAttachGenerationAssets,
  validateAndAttachGenerationUploads,
  validateInputsAgainstSlots,
} from './validation'

function slotInputs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    uploadId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    role: 'reference_image',
    position: i,
  }))
}

test('slot validation honors lowered runtime maxInputs', () => {
  const inputs = slotInputs(2)
  assert.equal(validateInputsAgainstSlots(inputs, [], { maxInputs: 2 }).length, 2)
  assert.throws(
    () => validateInputsAgainstSlots(inputs, [], { maxInputs: 1 }),
    (err: unknown) => err instanceof GenerationInputError && err.code === 'INVALID_INPUT',
  )
})

test('slot validation honors raised runtime maxInputs up to the absolute ceiling', () => {
  const inputs = slotInputs(10)
  assert.equal(validateInputsAgainstSlots(inputs, [], { maxInputs: 32 }).length, 10)
  assert.throws(
    () => validateInputsAgainstSlots(slotInputs(33), [], { maxInputs: 32 }),
    /参考图数量超出上限/,
  )
})

test('attach enforces resolved total and per-image limits', async () => {
  const mkClient = (sizeBytes: number) => ({
    query: async (sql: string) => {
      if (sql.includes('FROM media_uploads')) {
        return {
          rows: [
            { id: 'u1', status: 'ready', size_bytes: sizeBytes, expires_at: new Date(Date.now() + 60000), deleted_at: null, attached_job_id: null, media_kind: 'image' },
          ],
        }
      }
      return { rows: [] }
    },
  })
  const normalized = [{ uploadId: 'u1', role: 'reference_image', position: 0 }]
  await assert.rejects(
    validateAndAttachGenerationUploads(mkClient(200) as never, 'actor', 'job', normalized, {
      maxImageBytes: 100,
      maxTotalBytes: 1000,
      maxInputs: 32,
    }),
    /大小超出限制/,
  )
  await assert.rejects(
    validateAndAttachGenerationUploads(mkClient(60) as never, 'actor', 'job', normalized, {
      maxImageBytes: 1000,
      maxTotalBytes: 50,
      maxInputs: 32,
    }),
    /总大小超出限制/,
  )
  await validateAndAttachGenerationUploads(mkClient(60) as never, 'actor', 'job', normalized, {
    maxImageBytes: 100,
    maxTotalBytes: 100,
    maxInputs: 32,
  })
})

const ASSET_1 = '00000000-0000-4000-8000-000000000001'
const UPLOAD_1 = '00000000-0000-4000-8000-0000000000e1'
const READY_UPLOAD = {
  id: UPLOAD_1,
  status: 'ready',
  size_bytes: 60,
  expires_at: new Date(Date.now() + 60000),
  deleted_at: null,
  attached_job_id: null,
  media_kind: 'image',
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_1,
    media_kind: 'image',
    mime_type: 'image/png',
    width: 1024,
    height: 1024,
    size_bytes: 60,
    ...overrides,
  }
}

/** Records every statement so a test can assert what was *not* written. */
function recordingClient(rows: Record<string, unknown>[], uploadRows: Record<string, unknown>[] = []) {
  const queries: string[] = []
  return {
    queries,
    query: async (sql: string) => {
      queries.push(sql)
      if (sql.includes('FROM assets')) return { rows }
      if (sql.includes('FROM media_uploads')) return { rows: uploadRows }
      return { rows: [] }
    },
  }
}

const assetInput = (assetId: string, position = 0) => ({ assetId, role: 'reference_image', position })

test('normalize accepts assetId references and keeps the two id kinds apart', () => {
  assert.deepEqual(normalizeGenerationInputs([assetInput(ASSET_1)]), [
    { assetId: ASSET_1, role: 'reference_image', position: 0 },
  ])

  // One uuid used as an upload and as an asset is two different images.
  assert.equal(
    normalizeGenerationInputs([{ uploadId: ASSET_1, role: 'reference_image', position: 0 }, assetInput(ASSET_1, 1)]).length,
    2,
  )

  assert.throws(() => normalizeGenerationInputs([assetInput(ASSET_1), assetInput(ASSET_1, 1)]), /assetId 重复/)
  assert.throws(
    () => normalizeGenerationInputs([{ uploadId: UPLOAD_1, assetId: ASSET_1, role: 'reference_image', position: 0 }]),
    /不能同时携带/,
  )
  assert.throws(() => normalizeGenerationInputs([{ role: 'reference_image', position: 0 }]), /必须提供/)
  assert.throws(() => normalizeGenerationInputs([assetInput('not-a-uuid')]), /assetId 格式无效/)
})

test('a gallery-only input binds the asset and touches nothing else', async () => {
  const client = recordingClient([assetRow()])

  await validateAndAttachGenerationAssets(client as never, 'actor', 'job', [assetInput(ASSET_1)])

  const inserts = client.queries.filter((sql) => sql.includes('INSERT INTO generation_job_inputs'))
  assert.equal(inserts.length, 1)
  assert.match(inserts[0], /asset_id/)
  assert.ok(
    !client.queries.some((sql) => /UPDATE assets|UPDATE media_uploads|UPDATE generation_input_images|FROM media_uploads/.test(sql)),
    'a gallery image is referenced, never claimed, mutated, or re-uploaded',
  )
  // input_image_id stays NULL so the UNIQUE legacy column is not occupied.
  assert.match(inserts[0], /VALUES\(\$1, NULL, NULL, \$2, \$3, \$4\)/)
})

test('asset ownership is enforced by the query, not by hiding rows in the UI', async () => {
  const client = recordingClient([assetRow()])
  await validateAndAttachGenerationAssets(client as never, 'actor-7', 'job', [assetInput(ASSET_1)])
  const select = client.queries.find((sql) => sql.includes('FROM assets')) ?? ''
  assert.match(select, /created_by = \$2/)
  assert.match(select, /deleted_at IS NULL/)

  // Another user's image simply is not returned, so the attach fails.
  await assert.rejects(
    validateAndAttachGenerationAssets(recordingClient([]) as never, 'actor-7', 'job', [assetInput(ASSET_1)]),
    (err: unknown) => err instanceof GenerationInputError && err.code === 'INPUT_IMAGE_UNAVAILABLE',
  )
})

test('gallery images the worker could not decode are refused at submit time', async () => {
  const rejects = async (overrides: Record<string, unknown>, pattern: RegExp) => {
    await assert.rejects(
      validateAndAttachGenerationAssets(
        recordingClient([assetRow(overrides)]) as never,
        'actor',
        'job',
        [assetInput(ASSET_1)],
      ),
      pattern,
    )
  }

  // inspectImageBytes only understands PNG and JPEG magic bytes, so a WebP artifact
  // can never be a generation input no matter what the gallery shows.
  await rejects({ mime_type: 'image/webp' }, /格式不支持/)
  await rejects({ media_kind: 'video' }, /格式不支持/)
  await rejects({ width: 16 }, /分辨率/)
  await rejects({ width: 8000 }, /分辨率/)
  await rejects({ width: 6000, height: 100 }, /宽高比/)
})

test('uploads and gallery picks share one pooled total-size budget', async () => {
  const mixed = [{ uploadId: UPLOAD_1, role: 'reference_image', position: 0 }, assetInput(ASSET_1, 1)]
  const limits = { maxImageBytes: 100, maxTotalBytes: 100, maxInputs: 32 }

  // 60 bytes from the upload plus 60 from the asset: each branch alone fits.
  await assert.rejects(
    attachGenerationInputs(recordingClient([assetRow()], [READY_UPLOAD]) as never, 'actor', 'job', mixed, limits),
    /总大小超出限制/,
  )

  // With room for both, the same request succeeds and both linkage rows appear.
  const roomy = recordingClient([assetRow()], [READY_UPLOAD])
  await attachGenerationInputs(roomy as never, 'actor', 'job', mixed, { ...limits, maxTotalBytes: 200 })
  const inserts = roomy.queries.filter((sql) => sql.includes('INSERT INTO generation_job_inputs'))
  assert.equal(inserts.length, 2, 'one row per input, regardless of provenance')
  assert.ok(roomy.queries.some((sql) => sql.includes('asset_id')), 'the gallery pick was attached')
  assert.ok(roomy.queries.some((sql) => sql.includes("SET status='attached'")), 'the upload was claimed')
})

test('a gallery-only request never queries the upload tables', async () => {
  const client = recordingClient([assetRow()])
  await attachGenerationInputs(client as never, 'actor', 'job', [assetInput(ASSET_1)], {
    maxImageBytes: 100,
    maxTotalBytes: 1000,
    maxInputs: 32,
  })
  assert.ok(!client.queries.some((sql) => sql.includes('FROM media_uploads')), 'no empty ANY() probe for upload-less requests')
  assert.equal(client.queries.filter((sql) => sql.includes('INSERT INTO generation_job_inputs')).length, 1)
})
