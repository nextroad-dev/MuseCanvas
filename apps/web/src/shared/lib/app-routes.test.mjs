import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTs } from '../services/mock-workspace-test-loader.mjs'

const {
  APP_ROUTES,
  agentSessionRoute,
  assetDetailHref,
  assetIdFromSearch,
  isOnAdmin,
  isOnGenerate,
  loginHref,
  safeRedirectPath,
} = loadTs(new URL('./app-routes.ts', import.meta.url))

const ASSET_ID = '00000000-0000-4000-8000-000000000501'

test('agent session navigation encodes ids as a stable deep route', () => {
  const id = '00000000-0000-4000-8000-000000000401'
  assert.equal(agentSessionRoute(id), `/agent/sessions/${id}`)
  assert.equal(isOnGenerate(agentSessionRoute(id)), true)
  assert.equal(agentSessionRoute('a/b'), '/agent/sessions/a%2Fb')
})

test('asset detail deep links accept only UUID ids and fall back to null', () => {
  assert.equal(assetDetailHref(ASSET_ID), `/library?asset=${ASSET_ID}`)
  assert.equal(assetDetailHref(ASSET_ID.toUpperCase()), `/library?asset=${ASSET_ID}`)
  assert.equal(assetDetailHref(` ${ASSET_ID} `), `/library?asset=${ASSET_ID}`)
  assert.equal(assetDetailHref('asset-1'), null)
  assert.equal(assetDetailHref('../../admin'), null)
  assert.equal(assetDetailHref(''), null)
})

test('asset id parsing tolerates absent, malformed and foreign query strings', () => {
  assert.equal(assetIdFromSearch(`?asset=${ASSET_ID}`), ASSET_ID)
  assert.equal(assetIdFromSearch(`asset=${ASSET_ID.toUpperCase()}&q=cat`), ASSET_ID)
  assert.equal(assetIdFromSearch('?asset=not-a-uuid'), null)
  assert.equal(assetIdFromSearch('?asset='), null)
  assert.equal(assetIdFromSearch('?q=cat'), null)
  assert.equal(assetIdFromSearch('?asset=../../admin'), null)
  assert.equal(assetIdFromSearch(''), null)
  assert.equal(assetIdFromSearch(null), null)
  assert.equal(assetIdFromSearch(undefined), null)
})

test('APP_ROUTES exposes all 10 admin routes and matches isOnAdmin', () => {
  const adminRoutes = [
    APP_ROUTES.admin,
    APP_ROUTES.adminUsers,
    APP_ROUTES.adminInvitations,
    APP_ROUTES.adminModels,
    APP_ROUTES.adminProviders,
    APP_ROUTES.adminPlugins,
    APP_ROUTES.adminPromptTemplates,
    APP_ROUTES.adminJobs,
    APP_ROUTES.adminOAuth,
    APP_ROUTES.adminSettings,
  ]
  assert.deepEqual(adminRoutes, [
    '/admin',
    '/admin/users',
    '/admin/invitations',
    '/admin/models',
    '/admin/providers',
    '/admin/plugins',
    '/admin/prompt-templates',
    '/admin/jobs',
    '/admin/oauth',
    '/admin/settings',
  ])
  for (const route of adminRoutes) {
    assert.equal(isOnAdmin(route), true)
  }
  assert.equal(isOnAdmin('/generate'), false)
  assert.equal(isOnAdmin('/administrator'), false)
})

test('loginHref encodes safe next targets and omits query when nextPath is absent', () => {
  assert.equal(loginHref(), '/login')
  assert.equal(loginHref(''), '/login')
  assert.equal(loginHref('/admin/models'), '/login?next=%2Fadmin%2Fmodels')
  assert.equal(loginHref('/library?kind=video'), '/login?next=%2Flibrary%3Fkind%3Dvideo')
  assert.equal(loginHref('https://evil.example/phish'), '/login?next=%2Fgenerate')
  assert.equal(loginHref('//evil.example/phish'), '/login?next=%2Fgenerate')
  assert.equal(loginHref('/\\evil.example/phish'), '/login?next=%2Fgenerate')
  assert.equal(safeRedirectPath('/account'), '/account')
  assert.equal(safeRedirectPath('https://evil.example'), '/generate')
})
