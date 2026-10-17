import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MediaModelErrorCode,
  parseUpdateMediaModelDefaultsRequest,
} from './media-parameters'

const IMAGE_ID = '123e4567-e89b-12d3-a456-426614174000'
const VIDEO_ID = '223e4567-e89b-12d3-a456-426614174001'

test('error codes name the two default-model failure modes', () => {
  assert.deepEqual({ ...MediaModelErrorCode }, {
    DEFAULT_MODEL_INVALID: 'DEFAULT_MODEL_INVALID',
    DEFAULT_MODEL_IN_USE: 'DEFAULT_MODEL_IN_USE',
  })
})

test('parser accepts single-kind patches and normalizes UUID case', () => {
  const single = parseUpdateMediaModelDefaultsRequest({ imageModelId: IMAGE_ID.toUpperCase() })
  assert.equal(single.success, true)
  if (single.success) assert.deepEqual(single.data, { imageModelId: IMAGE_ID })

  const both = parseUpdateMediaModelDefaultsRequest({ imageModelId: IMAGE_ID, videoModelId: VIDEO_ID })
  assert.equal(both.success, true)
  if (both.success) assert.deepEqual(both.data, { imageModelId: IMAGE_ID, videoModelId: VIDEO_ID })
})

test('parser accepts explicit null as a clear and rejects empty or unknown patches', () => {
  const clear = parseUpdateMediaModelDefaultsRequest({ videoModelId: null })
  assert.equal(clear.success, true)
  if (clear.success) assert.deepEqual(clear.data, { videoModelId: null })

  for (const input of [{}, [], null, 'x', { imageModelId: IMAGE_ID, role: 'admin' }, { videoModelId: 42 }]) {
    const parsed = parseUpdateMediaModelDefaultsRequest(input)
    assert.equal(parsed.success, false, JSON.stringify(input))
    if (!parsed.success) assert.equal(parsed.error.code, 'INVALID_INPUT')
  }
})

test('parser rejects non-UUID model ids', () => {
  for (const input of [{ imageModelId: '' }, { imageModelId: 'not-a-uuid' }, { videoModelId: 'zzz' }]) {
    const parsed = parseUpdateMediaModelDefaultsRequest(input)
    assert.equal(parsed.success, false, JSON.stringify(input))
  }
})
