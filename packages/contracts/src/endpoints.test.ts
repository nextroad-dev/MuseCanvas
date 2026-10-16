import test from 'node:test'
import assert from 'node:assert/strict'
import { API_ENDPOINTS, OAUTH_PROVIDERS } from './endpoints'

test('static endpoints carry the /api prefix and match backend route strings', () => {
  assert.equal(API_ENDPOINTS.session, '/api/session')
  assert.equal(API_ENDPOINTS.registration, '/api/registration')
  assert.equal(API_ENDPOINTS.library.list, '/api/library')
  assert.equal(API_ENDPOINTS.generations, '/api/generations')
  assert.equal(API_ENDPOINTS.images.edit, '/api/images/edit')
  assert.equal(API_ENDPOINTS.setup.status, '/api/setup/status')
  assert.equal(API_ENDPOINTS.setup.smtpTest, '/api/setup/smtp/test')
  assert.equal(API_ENDPOINTS.admin.modelPresets, '/api/admin/model-presets')
  assert.equal(API_ENDPOINTS.admin.promptTemplatesExport, '/api/admin/prompt-templates/export')
  assert.equal(API_ENDPOINTS.admin.plugins, '/api/admin/plugins')
  assert.equal(API_ENDPOINTS.admin.pluginUpload, '/api/admin/plugins/upload')
  assert.equal(API_ENDPOINTS.admin.pluginValidate, '/api/admin/plugins/validate')
})

test('dynamic helpers interpolate id and provider segments', () => {
  assert.equal(API_ENDPOINTS.auth.oauthStart('github'), '/api/auth/oauth/github/start')
  assert.equal(API_ENDPOINTS.auth.oauthCallback('google'), '/api/auth/oauth/google/callback')
  assert.equal(API_ENDPOINTS.account.oauthLinkStart('google'), '/api/account/oauth/google/link/start')
  assert.equal(API_ENDPOINTS.account.oauthUnlink('github'), '/api/account/oauth/github')
  assert.equal(API_ENDPOINTS.jobs.detail('j1'), '/api/jobs/j1')
  assert.equal(API_ENDPOINTS.jobs.cancel('j1'), '/api/jobs/j1/cancel')
  assert.equal(API_ENDPOINTS.jobs.retry('j1'), '/api/jobs/j1/retry')
  assert.equal(API_ENDPOINTS.library.download('a1'), '/api/library/a1/download')
  assert.equal(API_ENDPOINTS.generationUploads.complete('u1'), '/api/generation-uploads/u1/complete')
  assert.equal(API_ENDPOINTS.generationUploads.remove('u1'), '/api/generation-uploads/u1')
  assert.equal(API_ENDPOINTS.admin.providerCredentialTest('c1'), '/api/admin/provider-credentials/c1/test')
  assert.equal(API_ENDPOINTS.admin.oauthProvider('github'), '/api/admin/oauth-providers/github')
  assert.equal(API_ENDPOINTS.admin.promptTemplateSetEntries('s1'), '/api/admin/prompt-templates/sets/s1/entries')
  assert.equal(API_ENDPOINTS.admin.promptTemplateEntry('e1'), '/api/admin/prompt-templates/entries/e1')
  assert.equal(API_ENDPOINTS.admin.plugin('p1'), '/api/admin/plugins/p1')
  assert.equal(API_ENDPOINTS.admin.pluginIcon('p1'), '/api/admin/plugins/p1/icon')
  assert.equal(API_ENDPOINTS.admin.pluginPackage('p1'), '/api/admin/plugins/p1/package')
  assert.equal(API_ENDPOINTS.admin.pluginDocs('p1'), '/api/admin/plugins/p1/docs')
})

test('canvas M1/M2 endpoint samples use the shared helpers', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  assert.equal(API_ENDPOINTS.canvases.list, '/api/canvases')
  assert.equal(API_ENDPOINTS.canvases.create, '/api/canvases')
  assert.equal(API_ENDPOINTS.canvases.detail(id), `/api/canvases/${id}`)
  assert.equal(API_ENDPOINTS.canvases.update(id), `/api/canvases/${id}`)
  assert.equal(API_ENDPOINTS.canvases.remove(id), `/api/canvases/${id}`)
  assert.equal(API_ENDPOINTS.canvases.agent.messages(id), `/api/canvases/${id}/agent/messages`)
  assert.equal(API_ENDPOINTS.canvases.agent.turn(id, id), `/api/canvases/${id}/agent/turns/${id}`)
  assert.equal(API_ENDPOINTS.canvases.agent.history(id), `/api/canvases/${id}/agent/history`)
  assert.equal(API_ENDPOINTS.canvases.agent.confirm(id), `/api/canvases/${id}/agent/confirm`)
  assert.equal(API_ENDPOINTS.canvases.agent.apply(id), `/api/canvases/${id}/agent/apply`)
  assert.equal(API_ENDPOINTS.canvasAgent.status, '/api/canvas-agent/status')
  assert.equal(API_ENDPOINTS.admin.canvasAgentSettings, '/api/admin/canvas-agent-settings')
  assert.equal(API_ENDPOINTS.admin.mediaModelDefaults, '/api/admin/media-model-defaults')
})

test('oauth provider whitelist matches backend path.match constraint', () => {
  assert.deepEqual([...OAUTH_PROVIDERS], ['github', 'google'])
})
