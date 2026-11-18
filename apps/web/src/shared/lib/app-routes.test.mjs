import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTs } from '../services/mock-workspace-test-loader.mjs'

const { agentSessionRoute, assetDetailHref, assetIdFromSearch, isOnGenerate } = loadTs(
  new URL('./app-routes.ts', import.meta.url),
)

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
