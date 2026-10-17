import assert from 'node:assert/strict'
import test from 'node:test'
import { NormalizedProviderError } from '@musecanvas/providers'
import { credentialProbeErrorCode, probeCandidates, resolveCredentialPlugin } from './probe'

test('connectivity probes use one complete plugin identity and never mix sources', () => {
  assert.deepEqual(
    resolveCredentialPlugin({ plugin_id: 'seedream-image', plugin_version: '1.1.0' }, {}),
    { pluginId: 'seedream-image', pluginVersion: '1.1.0' },
  )
  assert.deepEqual(
    resolveCredentialPlugin(null, { configured_fields: { pluginId: 'openai-image', pluginVersion: '1.1.0' } }),
    { pluginId: 'openai-image', pluginVersion: '1.1.0' },
  )
  assert.deepEqual(
    resolveCredentialPlugin(null, { configured_fields: JSON.stringify({ pluginId: 'openai-image', pluginVersion: '1.0.0' }) }),
    { pluginId: 'openai-image', pluginVersion: '1.0.0' },
  )
  // The linked model wins over the credential's template hint.
  assert.deepEqual(
    resolveCredentialPlugin(
      { plugin_id: 'seedream-image', plugin_version: '1.1.0' },
      { configured_fields: { pluginId: 'openai-image', pluginVersion: '1.1.0' } },
    ),
    { pluginId: 'seedream-image', pluginVersion: '1.1.0' },
  )
  assert.equal(resolveCredentialPlugin(null, {}), null)
  assert.equal(resolveCredentialPlugin({ plugin_id: 'seedream-image' }, {}), null)
  assert.equal(resolveCredentialPlugin({ plugin_id: 'seedream-image' }, { configured_fields: { pluginVersion: '1.1.0' } }), null)
  assert.equal(resolveCredentialPlugin({ plugin_version: '1.1.0' }, { configured_fields: { pluginId: 'openai-image' } }), null)
  assert.deepEqual(
    resolveCredentialPlugin({ plugin_id: 'seedream-image' }, { configured_fields: { pluginId: 'openai-image', pluginVersion: '1.1.0' } }),
    { pluginId: 'openai-image', pluginVersion: '1.1.0' },
  )
})

test('without a named plugin, any available plugin the credential could back may probe it', () => {
  const keys = (row: { provider_id: string; schema_id: string; base_url: string | null }) =>
    probeCandidates(row).map(key => `${key.pluginId}@${key.pluginVersion}`).sort()
  // One Ark account: both Seedream versions and Seedance.
  assert.deepEqual(
    keys({ provider_id: 'volcengine', schema_id: 'legacy-api-key-v1', base_url: null }),
    ['seedance-video@1.0.0', 'seedream-image@1.0.0', 'seedream-image@1.1.0'],
  )
  // A gateway endpoint rules out the pinned 1.1.0 image plugin.
  assert.deepEqual(
    keys({ provider_id: 'openai', schema_id: 'legacy-api-key-v1', base_url: 'https://gateway.example.com' }),
    ['openai-image@1.0.0'],
  )
  // Language-only accounts have no media plugin to probe with.
  assert.deepEqual(keys({ provider_id: 'anthropic', schema_id: 'legacy-api-key-v1', base_url: null }), [])
})

test('probe failures map onto the stable credential-test vocabulary', () => {
  const normalized = (code: string, status?: number) =>
    NormalizedProviderError.create('p', '1.0.0', code as never, 'detail', status === undefined ? undefined : { status })
  assert.equal(credentialProbeErrorCode(normalized('PROVIDER_REJECTED')), 'PROVIDER_REJECTED')
  assert.equal(credentialProbeErrorCode(normalized('PROVIDER_NOT_CONFIGURED')), 'PLUGIN_NOT_REGISTERED')
  assert.equal(credentialProbeErrorCode(new Error('HTTP_503')), 'PROVIDER_TEMPORARY_ERROR')
  assert.equal(credentialProbeErrorCode(new Error('HTTP_401')), 'PROVIDER_REJECTED')
  assert.equal(credentialProbeErrorCode(new Error('something odd')), 'CONNECTIVITY_FAILED')
})
