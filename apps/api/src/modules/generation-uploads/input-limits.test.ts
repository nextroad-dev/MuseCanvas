import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GenerationInputError,
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
