import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildMediaModelDefaultsRequest } from './media-model-defaults-form.ts'

const current = () => ({
  imageModelId: '10000000-0000-4000-8000-000000000001',
  videoModelId: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
})

test('builds independent partial elections for image and video defaults', () => {
  const image = buildMediaModelDefaultsRequest(current(), {
    imageModelId: '20000000-0000-4000-8000-000000000002',
    videoModelId: '',
  })
  assert.deepEqual(image, { imageModelId: '20000000-0000-4000-8000-000000000002' })

  const video = buildMediaModelDefaultsRequest(current(), {
    imageModelId: current().imageModelId,
    videoModelId: '30000000-0000-4000-8000-000000000003',
  })
  assert.deepEqual(video, { videoModelId: '30000000-0000-4000-8000-000000000003' })
})

test('omits unchanged values and never emits null or empty fields', () => {
  assert.deepEqual(buildMediaModelDefaultsRequest(current(), {
    imageModelId: current().imageModelId,
    videoModelId: '',
  }), {})
  assert.deepEqual(buildMediaModelDefaultsRequest(current(), {
    imageModelId: '',
    videoModelId: '',
  }), {})
})

test('supports changing both kinds in one request', () => {
  const result = buildMediaModelDefaultsRequest(current(), {
    imageModelId: '20000000-0000-4000-8000-000000000002',
    videoModelId: '30000000-0000-4000-8000-000000000003',
  })
  assert.deepEqual(result, {
    imageModelId: '20000000-0000-4000-8000-000000000002',
    videoModelId: '30000000-0000-4000-8000-000000000003',
  })
})
