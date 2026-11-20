import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTs } from './mock-workspace-test-loader.mjs'

const identity = loadTs(new URL('./mock-identity.ts', import.meta.url), {})
const mock = loadTs(new URL('./mock-admin-api.ts', import.meta.url), { './mock-identity': identity })
const get = (path, params) => mock.mockApiFetch(path, { method: 'GET', params })
const send = (method, path, body) => mock.mockApiFetch(path, { method, body })

test('session, account and setup fixtures never need a real API', async () => {
  const session = await get('/api/session')
  assert.equal(session.user.role, 'admin')
  assert.equal(session.user.email, 'admin@example.invalid')
  const identities = await get('/api/account/oauth')
  assert.equal(identities.length, 1)
  assert.equal(identities[0].provider, 'github')
  const status = await get('/api/setup/status')
  assert.equal(status.setupComplete, true)
  const config = await get('/api/setup/config')
  assert.equal(config.site.siteName, 'MuseCanvas 演示站')
  assert.ok(config.templates.active)
  assert.equal((await send('POST', '/api/auth/logout')).loggedOut, true)
})

test('admin read endpoints return populated DTOs for every page', async () => {
  const dashboard = await get('/api/admin/dashboard')
  assert.equal(dashboard.totalUsers >= 4, true)
  assert.equal(dashboard.days.length, 7)

  const users = await get('/api/admin/users', { limit: 20 })
  assert.equal(users.hasMore, false)
  assert.ok(users.items.some(user => user.email === 'lin@example.invalid'))
  assert.equal((await get('/api/admin/users', { status: 'disabled' })).items.length, 1)

  const jobs = await get('/api/admin/jobs', { limit: 20 })
  assert.ok(jobs.items.some(job => job.status === 'running'))
  assert.equal((await get('/api/admin/jobs', { status: 'failed' })).items.length, 1)

  assert.equal((await get('/api/admin/invitations')).items.length, 2)
  assert.ok((await get('/api/admin/models')).some(model => model.modelKind === 'video'))
  assert.ok((await get('/api/admin/model-presets')).length >= 3)
  assert.ok((await get('/api/admin/provider-credentials')).length >= 2)
  assert.equal((await get('/api/admin/provider-templates')).templates.length, 2)
  assert.ok((await get('/api/admin/plugins')).every(plugin => plugin.artifactDigest.length === 64))
  assert.equal((await get('/api/admin/oauth-providers')).length, 2)
  assert.ok((await get('/api/admin/prompt-templates')).entries.length >= 3)
  assert.equal((await get('/api/admin/prompt-templates/sets')).length, 2)
  assert.equal((await get('/api/admin/media-model-defaults')).imageModelId, 'seedream-4-5')
  assert.equal((await get('/api/admin/prompt-optimization-settings')).enabled, false)
  assert.equal((await get('/api/admin/registration')).requiresInvitation, false)
})

test('admin mutations change the in-memory store and are visible on refetch', async () => {
  const users = await get('/api/admin/users', { limit: 20 })
  const target = users.items.find(user => user.email === 'studio@example.invalid')
  assert.ok(target)
  const disabled = await send('PATCH', `/api/admin/users/${target.id}/status`, { status: 'disabled' })
  assert.equal(disabled.status, 'disabled')
  assert.equal((await get('/api/admin/users', { limit: 20 })).items.filter(user => user.status === 'disabled').length, 2)

  const invitation = await send('POST', '/api/admin/invitations')
  assert.equal(invitation.used, false)
  assert.equal((await get('/api/admin/invitations')).items.length, 3)
  await send('DELETE', `/api/admin/invitations/${invitation.id}`)
  assert.equal((await get('/api/admin/invitations')).items.length, 2)

  const model = await send('POST', '/api/admin/models', { displayName: '演示新模型', modelKind: 'image', providerCredentialId: null })
  assert.equal(model.displayName, '演示新模型')
  assert.equal((await get('/api/admin/models')).some(item => item.id === model.id), true)
  await send('DELETE', `/api/admin/models/${model.id}`)
  assert.equal((await get('/api/admin/models')).some(item => item.id === model.id), false)

  const credential = await send('POST', '/api/admin/provider-credentials', { displayName: '演示凭据', providerId: 'openai', secret: 'demo' })
  assert.equal(credential.hasCredential, true)
  assert.equal((await send('POST', `/api/admin/provider-credentials/${credential.id}/test`)).tested, true)

  await send('PATCH', '/api/admin/media-model-defaults', { imageModelId: 'gpt-image-2' })
  assert.equal((await get('/api/admin/media-model-defaults')).imageModelId, 'gpt-image-2')

  const set = await get('/api/admin/prompt-templates')
  const entry = await send('POST', `/api/admin/prompt-templates/sets/${set.id}/entries`, { name: '新条目', instruction: '写一个演示模板' })
  assert.equal(entry.entries.some(item => item.name === '新条目'), true)
  assert.equal(entry.entryCount, entry.entries.length)
  const updated = await send('PATCH', `/api/admin/prompt-templates/entries/${entry.entries[0].id}`, { name: '重命名条目' })
  assert.equal(updated.entries[0].name, '重命名条目')
})

test('mock never falls through to network and exposes local asset URLs', async () => {
  await assert.rejects(get('/api/admin/does-not-exist'), /MOCK_UNHANDLED/)
  assert.match(mock.mockPluginIconUrl(), /^data:image\/svg\+xml,/)
  assert.match(mock.mockPromptExportUrl(), /^data:application\/json/)
})
