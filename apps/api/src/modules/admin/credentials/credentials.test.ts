import assert from 'node:assert/strict'
import test from 'node:test'

process.env.APP_MASTER_KEY = process.env.APP_MASTER_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

import { globalProviderRegistry } from '@musecanvas/providers'
import { credentialTestFailureMessage, settledOutcome } from './connectivity'
import { parseCredentialInput } from './input'
import { credentialRedirected } from './service'
import { credentialBindingError, resolveCredentialTarget } from './validate'

const manifestOf = (id: string, version: string) => globalProviderRegistry.get(id, version).manifest

const serviceAccount = JSON.stringify({
  type: 'service_account', project_id: 'demo-project',
  client_email: 'veo@demo-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
})

test('request spellings normalize to one credential input', () => {
  const legacy = parseCredentialInput({ displayName: ' Ark ', adapter: 'seedream', apiKey: ' sk-1 ' })
  assert.deepEqual(legacy, { ok: true, input: { displayName: 'Ark', providerId: 'volcengine', secret: 'sk-1' } })

  // An object payload is serialized, and its own endpoint is used when none is given.
  const object = parseCredentialInput({ providerId: 'google', credential: { client_email: 'a', baseUrl: 'https://us-central1-aiplatform.googleapis.com' } })
  assert.equal(object.ok && object.input.secret, '{"client_email":"a","baseUrl":"https://us-central1-aiplatform.googleapis.com"}')
  assert.equal(object.ok && object.input.baseUrl, 'https://us-central1-aiplatform.googleapis.com')

  // `secret` is the current spelling and wins over the deprecated ones.
  const current = parseCredentialInput({ providerId: 'openai', secret: 'sk-new', apiKey: 'sk-old' })
  assert.equal(current.ok && current.input.secret, 'sk-new')

  // An empty base URL clears; a null base URL clears too.
  assert.equal((parseCredentialInput({ baseUrl: '' }) as { input: { baseUrl: unknown } }).input.baseUrl, null)
  assert.equal((parseCredentialInput({ baseUrl: null }) as { input: { baseUrl: unknown } }).input.baseUrl, null)
  assert.equal('baseUrl' in (parseCredentialInput({}) as { input: object }).input, false)
})

test('malformed credential input is rejected with a stable code', () => {
  const code = (body: Record<string, unknown>) => {
    const parsed = parseCredentialInput(body)
    return parsed.ok ? null : parsed.code
  }
  assert.equal(code({ pluginId: 'openai-image' }), 'INVALID_INPUT')
  assert.equal(code({ displayName: '  ' }), 'INVALID_INPUT')
  assert.equal(code({ baseUrl: 'http://api.openai.com' }), 'INVALID_BASE_URL')
  assert.equal(code({ baseUrl: 'https://127.0.0.1' }), 'INVALID_BASE_URL')
  for (const bad of [0, -1, 1.5, 'abc', null]) assert.equal(code({ schemaVersion: bad }), 'INVALID_INPUT', String(bad))
  assert.equal(code({ schemaVersion: '3' }), null)
})

test('a template plugin applies its full declared contract', async () => {
  const resolve = (state: Parameters<typeof resolveCredentialTarget>[0]) => resolveCredentialTarget(state)
  const codeOf = async (state: Parameters<typeof resolveCredentialTarget>[0]) => {
    const result = await resolve(state)
    return result.ok ? null : result.code
  }
  const openai = { pluginId: 'openai-image', pluginVersion: '1.1.0' }
  const veo = { pluginId: 'veo-video', pluginVersion: '1.0.0' }

  assert.equal(await codeOf({ plugin: { pluginId: 'does-not-exist', pluginVersion: '9.9.9' }, secret: 'sk-x' }), 'INVALID_PLUGIN')
  assert.equal(await codeOf({ plugin: veo, schemaId: 'legacy-api-key-v1', secret: 'sk-x' }), 'INVALID_INPUT')
  assert.equal(await codeOf({ plugin: openai, providerId: 'volcengine', secret: 'sk-x' }), 'INVALID_INPUT')
  assert.equal(await codeOf({ plugin: openai, baseUrl: 'https://proxy.example.com', secret: 'sk-x' }), 'INVALID_BASE_URL')
  // Built-in validateConfig runs on the secret: Veo needs a usable service account.
  assert.equal(await codeOf({ plugin: veo, secret: '{broken json' }), 'INVALID_CREDENTIAL')
  assert.equal(
    await codeOf({ plugin: veo, secret: JSON.stringify({ type: 'service_account', project_id: 'demo', client_email: 'veo@demo.iam.gserviceaccount.com' }) }),
    'INVALID_CREDENTIAL',
  )

  // An empty endpoint becomes the plugin's declared default.
  assert.deepEqual(await resolve({ plugin: openai, secret: 'sk-test-key-123' }), {
    ok: true,
    value: { providerId: 'openai', schemaId: 'legacy-api-key-v1', schemaVersion: 1, baseUrl: 'https://api.openai.com', plugin: openai },
  })
  assert.deepEqual(await resolve({ plugin: veo, secret: serviceAccount }), {
    ok: true,
    value: { providerId: 'google', schemaId: 'json-v1', schemaVersion: 1, baseUrl: 'https://us-central1-aiplatform.googleapis.com', plugin: veo },
  })
  // Seedance's allowlist admits the BytePlus region the old exact-template rule refused.
  const byteplus = await resolve({ plugin: { pluginId: 'seedance-video', pluginVersion: '1.0.0' }, baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3', secret: 'ark-key' })
  assert.equal(byteplus.ok, true)
})

test('without a template the provider account decides, across all its plugins', async () => {
  // A compatible endpoint is fine for the OpenAI account: 1.0.0 image and the
  // language protocol both accept any https host.
  const compatible = await resolveCredentialTarget({ providerId: 'openai', baseUrl: 'https://gateway.example.com/v1', secret: 'sk-x' })
  assert.deepEqual(compatible, {
    ok: true,
    value: { providerId: 'openai', schemaId: 'legacy-api-key-v1', schemaVersion: 1, baseUrl: 'https://gateway.example.com/v1' },
  })
  // No template, no endpoint: nothing is filled in.
  const bare = await resolveCredentialTarget({ providerId: 'anthropic', secret: 'sk-ant' })
  assert.equal(bare.ok && bare.value.baseUrl, null)
  // Seedream 1.0.0 still serves compatible endpoints, so an Ark account may carry
  // one (binding to the pinned 1.1.0 is refused later, at model save).
  assert.equal((await resolveCredentialTarget({ providerId: 'volcengine', baseUrl: 'https://gateway.example.com', secret: 'ark' })).ok, true)
  // Every Google plugin stays inside the Vertex AI allowlist, so a foreign endpoint fits none.
  const foreign = await resolveCredentialTarget({ providerId: 'google', schemaId: 'json-v1', baseUrl: 'https://gateway.example.com', secret: serviceAccount })
  assert.equal(foreign.ok ? null : foreign.code, 'INVALID_BASE_URL')
  const missing = await resolveCredentialTarget({ secret: 'sk' })
  assert.equal(missing.ok ? null : missing.code, 'INVALID_INPUT')
})

test('a credential binds by provider account, schema and endpoint policy — never by plugin version', () => {
  const volcengine = { provider_id: 'volcengine', schema_id: 'legacy-api-key-v1', base_url: null }
  // One Ark account serves Seedream (either version) and Seedance alike.
  assert.equal(credentialBindingError(manifestOf('seedream-image', '1.1.0'), volcengine), null)
  assert.equal(credentialBindingError(manifestOf('seedream-image', '1.0.0'), volcengine), null)
  assert.equal(credentialBindingError(manifestOf('seedance-video', '1.0.0'), volcengine), null)
  assert.equal(credentialBindingError(manifestOf('veo-video', '1.0.0'), volcengine)?.code, 'INVALID_INPUT')
  // A credential's endpoint overrides the model's at runtime, so it must fit the
  // plugin's policy on its own: a gateway key serves 1.0.0 but never pinned 1.1.0.
  const gateway = { provider_id: 'openai', schema_id: 'legacy-api-key-v1', base_url: 'https://gateway.example.com' }
  assert.equal(credentialBindingError(manifestOf('openai-image', '1.0.0'), gateway), null)
  assert.equal(credentialBindingError(manifestOf('openai-image', '1.1.0'), gateway)?.code, 'INVALID_BASE_URL')
  assert.equal(credentialBindingError(manifestOf('openai-image', '1.1.0'), { ...gateway, base_url: 'https://api.openai.com' }), null)
  // A schema the plugin cannot decode never binds.
  assert.equal(credentialBindingError(manifestOf('veo-video', '1.0.0'), { provider_id: 'google', schema_id: 'legacy-api-key-v1' })?.code, 'INVALID_INPUT')
})

test('any change of provider, schema, template or host needs the secret again', () => {
  const stored = { providerId: 'openai', schemaId: 'legacy-api-key-v1', baseUrl: 'https://api.openai.com', plugin: { pluginId: 'openai-image', pluginVersion: '1.1.0' } }
  assert.equal(credentialRedirected(stored, { ...stored }), false)
  // The same host with another path is not a redirect.
  assert.equal(credentialRedirected(stored, { ...stored, baseUrl: 'https://api.openai.com/v1' }), false)
  assert.equal(credentialRedirected(stored, { ...stored, baseUrl: 'https://proxy.example.com' }), true)
  assert.equal(credentialRedirected(stored, { ...stored, baseUrl: null }), true)
  assert.equal(credentialRedirected(stored, { ...stored, providerId: 'volcengine' }), true)
  assert.equal(credentialRedirected(stored, { ...stored, schemaId: 'json-v1' }), true)
  assert.equal(credentialRedirected(stored, { ...stored, plugin: { pluginId: 'openai-image', pluginVersion: '1.0.0' } }), true)
  assert.equal(credentialRedirected(stored, { ...stored, plugin: undefined }), true)
})

test('a test response waits for a settled outcome and maps its code to a message', () => {
  assert.equal(settledOutcome(undefined), null)
  // Still open: the worker has not settled it yet.
  assert.equal(settledOutcome({ last_test_status: 'pending', last_test_error_code: null, test_requested_at: new Date() }), null)
  assert.deepEqual(settledOutcome({ last_test_status: 'success', last_test_error_code: null, test_requested_at: null }), { status: 'success' })
  assert.deepEqual(
    settledOutcome({ last_test_status: 'failed', last_test_error_code: 'PROVIDER_REJECTED', test_requested_at: null }),
    { status: 'failed', code: 'PROVIDER_REJECTED' },
  )
  assert.match(credentialTestFailureMessage('PROVIDER_REJECTED'), /拒绝访问/)
  assert.match(credentialTestFailureMessage('SOMETHING_NEW'), /凭据测试失败/)
})
