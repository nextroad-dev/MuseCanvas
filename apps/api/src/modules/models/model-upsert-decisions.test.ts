import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasForbiddenManualModelFields,
  modelOverrideError,
  modelSavePath,
} from './upsert-internal'

test('model override gate rejects capabilities before defaults and accepts empty overrides', () => {
  assert.equal(modelOverrideError({ capabilities: { parameters: [] }, defaults: { size: 'large' } }), 'capabilities')
  assert.equal(modelOverrideError({ defaults: { size: 'large' } }), 'defaults')
  assert.equal(modelOverrideError({ capabilities: {}, defaults: null }), null)
  assert.equal(modelOverrideError({}), null)
})

test('upsert routes explicit plugin identity to the plugin path and all other input to preset path', () => {
  assert.equal(modelSavePath({ pluginId: ' plugin-a ' }), 'plugin')
  assert.equal(modelSavePath({ pluginId: '  ' }), 'preset')
  assert.equal(modelSavePath({ presetId: 'builtin-preset' }), 'preset')
})

test('preset path rejects fields that may only come from a preset', () => {
  assert.equal(hasForbiddenManualModelFields({ displayName: 'manual' }), true)
  assert.equal(hasForbiddenManualModelFields({ pluginId: 'plugin' }), true)
  assert.equal(hasForbiddenManualModelFields({ concurrencyLimit: 3, enabled: true }), false)
  assert.equal(hasForbiddenManualModelFields({ displayName: undefined }), false)
})
