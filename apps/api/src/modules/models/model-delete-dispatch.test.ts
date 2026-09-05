import assert from 'node:assert/strict'
import test from 'node:test'
import { modelDeleteIdFromPath } from './handlers'

test('admin model DELETE path extracts the model id', () => {
  assert.equal(
    modelDeleteIdFromPath('admin/models/123e4567-e89b-12d3-a456-426614174000'),
    '123e4567-e89b-12d3-a456-426614174000',
  )
})

test('model delete matcher rejects collection and unrelated paths', () => {
  assert.equal(modelDeleteIdFromPath('admin/models'), null)
  assert.equal(modelDeleteIdFromPath('admin/users/123e4567-e89b-12d3-a456-426614174000'), null)
})
