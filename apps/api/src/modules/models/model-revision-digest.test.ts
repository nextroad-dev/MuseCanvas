import assert from 'node:assert/strict'
import test from 'node:test'
import { modelRevisionSnapshotDigest, type ModelRevisionSnapshotIdentity } from './handlers'

const base: ModelRevisionSnapshotIdentity = {
  modelId: 'model-1',
  providerId: 'volcengine',
  pluginId: 'seedream-image',
  pluginVersion: '1.1.0',
  credentialId: 'credential-a',
  credentialSchemaVersion: 1,
  normalizedConfig: { vendorModelId: 'doubao-seedream-4-5-251128', baseUrl: 'https://example.invalid', concurrencyLimit: 1, watermark: false, modelKind: 'image' },
  capabilities: { modes: ['text_to_image'], parameters: [], inputSlots: [], maxCount: 1, supportedMediaKinds: ['image'], declaredBy: 'plugin-manifest' },
  defaults: { size: '2048x2048' },
}

test('revision identity digest is stable for the same execution identity', () => {
  assert.equal(modelRevisionSnapshotDigest(base), modelRevisionSnapshotDigest({ ...base }))
})

test('revision identity digest changes when the bound credential changes', () => {
  // The regression: a credential swap used to reuse a revision that still
  // pinned the previous account, so the Worker executed with the old secret.
  assert.notEqual(
    modelRevisionSnapshotDigest(base),
    modelRevisionSnapshotDigest({ ...base, credentialId: 'credential-b' }),
  )
  assert.notEqual(
    modelRevisionSnapshotDigest(base),
    modelRevisionSnapshotDigest({ ...base, credentialId: null }),
  )
})

test('revision identity digest covers normalized execution settings and schema version', () => {
  const digest = modelRevisionSnapshotDigest(base)
  assert.notEqual(digest, modelRevisionSnapshotDigest({
    ...base,
    normalizedConfig: { ...base.normalizedConfig, watermark: true },
  }))
  assert.notEqual(digest, modelRevisionSnapshotDigest({
    ...base,
    normalizedConfig: { ...base.normalizedConfig, concurrencyLimit: 2 },
  }))
  assert.notEqual(digest, modelRevisionSnapshotDigest({ ...base, credentialSchemaVersion: 2 }))
})

test('revision identity digest still covers contract and plugin identity', () => {
  const digest = modelRevisionSnapshotDigest(base)
  assert.notEqual(digest, modelRevisionSnapshotDigest({ ...base, pluginVersion: '1.0.0' }))
  assert.notEqual(digest, modelRevisionSnapshotDigest({ ...base, defaults: { size: '1024x1024' } }))
  assert.notEqual(digest, modelRevisionSnapshotDigest({
    ...base,
    capabilities: { ...(base.capabilities as Record<string, unknown>), maxCount: 2 },
  }))
})
