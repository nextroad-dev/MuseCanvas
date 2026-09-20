import test from 'node:test'
import assert from 'node:assert/strict'
import { API_ENDPOINTS, OAUTH_PROVIDERS } from './endpoints'

test('static endpoints carry the /api prefix and match backend route strings', () => {
  assert.equal(API_ENDPOINTS.session, '/api/session')
  assert.equal(API_ENDPOINTS.registration, '/api/registration')
  assert.equal(API_ENDPOINTS.library.list, '/api/library')
  assert.equal(API_ENDPOINTS.generations, '/api/generations')
  assert.equal(API_ENDPOINTS.setup.status, '/api/setup/status')
  assert.equal(API_ENDPOINTS.setup.smtpTest, '/api/setup/smtp/test')
  assert.equal(API_ENDPOINTS.admin.modelPresets, '/api/admin/model-presets')
  assert.equal(API_ENDPOINTS.admin.promptTemplatesExport, '/api/admin/prompt-templates/export')
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
})

test('oauth provider whitelist matches backend path.match constraint', () => {
  assert.deepEqual([...OAUTH_PROVIDERS], ['github', 'google'])
})
