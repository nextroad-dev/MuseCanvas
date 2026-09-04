// Browser-safe unit tests for built-in provider template matching,
// credential payload identity, and override suppression (no DOM, no Vue).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTemplateCredentialInput,
  credentialsForPreset,
  isActiveBuiltinImagePreset,
  parseServiceAccountJson,
  presetPluginKey,
  templateConfiguredCount,
} from './provider-templates'
import type { BuiltinProviderTemplate, ProviderCredential } from '@/shared/types'

function credential(overrides: Partial<ProviderCredential> = {}): ProviderCredential {
  return {
    id: 'cred-1',
    displayName: 'cred',
    adapter: 'openai',
    baseUrl: '',
    enabled: true,
    hasApiKey: true,
    lastTestStatus: 'not_tested',
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as ProviderCredential
}

const veoTemplate: BuiltinProviderTemplate = {
  key: 'veo-video',
  pluginId: 'veo-video',
  pluginVersion: '1.0.0',
  providerId: 'google',
  adapter: 'veo',
  displayName: 'Veo Video',
  modality: 'video',
  baseUrl: 'https://us-central1-aiplatform.googleapis.com',
  credential: { schemaId: 'json-v1', schemaVersion: 1, kind: 'google_service_account', label: '服务账号' },
  presetIds: ['veo-3-1'],
  models: [{ id: 'veo-3.1-generate-001' }],
}

describe('credentialsForPreset', () => {
  it('matches built-in video presets by exact plugin identity, never by adapter', () => {
    const creds = [
      credential({ id: 'a', adapter: 'other', configuredFields: { pluginId: 'veo-video', pluginVersion: '1.0.0' } }),
      credential({ id: 'b', adapter: 'veo', providerId: 'google' }),
    ]
    const preset = { modelKind: 'video', providerId: 'google', pluginId: 'veo-video', pluginVersion: '1.0.0' } as const
    assert.deepEqual(credentialsForPreset(creds, preset).map((c) => c.id), ['a'])
  })

  it('falls back to providerId only for legacy records without plugin identity', () => {
    const creds = [
      credential({ id: 'legacy', adapter: 'seedream', providerId: 'volcengine' }),
      credential({ id: 'other-plugin', adapter: 'seedream', providerId: 'volcengine', configuredFields: { pluginId: 'other', pluginVersion: '9.9.9' } }),
    ]
    const preset = { modelKind: 'video', adapter: undefined, providerId: 'volcengine', pluginId: 'seedance-video', pluginVersion: '1.0.0' } as const
    assert.deepEqual(credentialsForPreset(creds, preset).map((c) => c.id), ['legacy'])
  })

  it('ignores disabled credentials and preserves the language adapter flow', () => {
    const creds = [
      credential({ id: 'off', adapter: 'openai', enabled: false }),
      credential({ id: 'on', adapter: 'openai' }),
    ]
    const preset = { modelKind: 'language', adapter: 'openai' } as const
    assert.deepEqual(credentialsForPreset(creds, preset).map((c) => c.id), ['on'])
  })
})

describe('template credential payloads', () => {
  it('persists exact plugin identity and schema', () => {
    const input = buildTemplateCredentialInput(veoTemplate, { client_email: 'a', private_key: 'b' }, '  ')
    assert.equal(input.displayName, 'Veo Video')
    assert.equal(input.providerId, 'google')
    assert.equal(input.adapter, 'veo')
    assert.equal(input.pluginId, 'veo-video')
    assert.equal(input.pluginVersion, '1.0.0')
    assert.equal(input.schemaId, 'json-v1')
    assert.equal(input.schemaVersion, 1)
    assert.equal(input.baseUrl, 'https://us-central1-aiplatform.googleapis.com')
    assert.equal(typeof input.credential, 'object')
  })

  it('requires a service-account object with client_email and private_key', () => {
    assert.equal(parseServiceAccountJson('not json').ok, false)
    assert.equal(parseServiceAccountJson('[]').ok, false)
    assert.equal(parseServiceAccountJson('{"client_email":"a"}').ok, false)
    assert.equal(parseServiceAccountJson('{"client_email":"a","private_key":"b"}').ok, true)
  })

  it('exposes exact identity via configured count and plugin key', () => {
    const creds = [
      credential({ configuredFields: { pluginId: 'veo-video', pluginVersion: '1.0.0' } }),
      credential({ id: 'x', configuredFields: { pluginId: 'veo-video', pluginVersion: '2.0.0' } }),
    ]
    assert.equal(templateConfiguredCount(creds, veoTemplate), 1)
    assert.equal(presetPluginKey({ pluginId: 'veo-video', pluginVersion: '1.0.0' }), 'veo-video@1.0.0')
    assert.equal(presetPluginKey({}), null)
  })

  it('suppresses custom overrides only for active built-in image presets', () => {
    assert.equal(isActiveBuiltinImagePreset({ modelKind: 'image', pluginId: 'openai-image', pluginVersion: '1.1.0' }), true)
    assert.equal(isActiveBuiltinImagePreset({ modelKind: 'video', pluginId: 'veo-video', pluginVersion: '1.0.0' }), false)
    assert.equal(isActiveBuiltinImagePreset({ modelKind: 'language' }), false)
  })
})
