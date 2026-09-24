import assert from 'node:assert/strict'
import test from 'node:test'
import { providerCredentialMatchesPluginTarget } from './handlers'
import {
  hasForbiddenManualModelFields,
  modelOverrideError,
  modelSavePath,
  presetRevisionOrRow,
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

test('credential identity must match the selected plugin and version', () => {
  const target = { providerId: 'provider-a', pluginId: 'plugin-a', pluginVersion: '1.0.0' }
  assert.equal(providerCredentialMatchesPluginTarget({ provider_id: 'different', configured_fields: { pluginId: 'plugin-a', pluginVersion: '1.0.0' } }, target), true)
  assert.equal(providerCredentialMatchesPluginTarget({ provider_id: 'provider-a', configured_fields: { pluginId: 'plugin-b', pluginVersion: '1.0.0' } }, target), false)
  assert.equal(providerCredentialMatchesPluginTarget({ provider_id: 'provider-a', configured_fields: {} }, target), true)
})

test('preset revision snapshot failure returns the pre-revision row', async () => {
  const row = { id: 'model-1', latest_revision_id: null }
  const result = await presetRevisionOrRow(row, async () => { throw new Error('revision unavailable') })
  assert.equal(result, row)
})

test('successful preset revision returns the snapshotted row', async () => {
  const row = { id: 'model-1' }
  const snapshotted = { id: 'model-1', latest_revision_id: 'revision-1' }
  assert.equal(await presetRevisionOrRow(row, async () => snapshotted), snapshotted)
})
