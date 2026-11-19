import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mock } from 'node:test'
import { db } from '@musecanvas/database'
import type { AuthedContext } from '../router/types'
import { getLibraryAsset } from './library/handlers'
import { matchRoute } from '../router/match'
import { GET_ROUTES } from '../router/routes'
import { invalidateRuntimeSettings } from './settings/runtime'

const ASSET_ID = '44444444-4444-4444-8444-444444444444'
const ACTOR_ID = '33333333-3333-4333-8333-333333333333'

test('library asset detail scopes lookup to actor and excludes deleted assets/jobs', async () => {
  const query = mock.method(db(), 'query', async (sql: string, values: unknown[] = []) => {
    assert.match(sql, /a\.id=\$1 AND a\.created_by=\$2 AND a\.deleted_at IS NULL AND j\.deleted_at IS NULL/)
    assert.match(sql, /LIMIT 1/)
    assert.deepEqual(values, [ASSET_ID, ACTOR_ID])
    return { rows: [] }
  })
  try {
    const response = await getLibraryAsset({
      actor: { id: ACTOR_ID, role: 'user' },
      params: { id: ASSET_ID },
    } as unknown as AuthedContext)
    assert.equal(response.status, 404)
  } finally {
    query.mock.restore()
  }
})


test('library malformed UUID reaches the real matched handler and answers 400 INVALID_INPUT without querying', async () => {
  const query = mock.method(db(), 'query', () => { throw new Error('must not query for malformed UUID') })
  try {
    for (const id of ['deadbeef', '----', ASSET_ID.replaceAll('-', '')]) {
      const path = `library/${id}`
      const matched = matchRoute(GET_ROUTES, path)
      assert.ok(matched)
      assert.equal(matched.route.path, 'library/:id')
      assert.equal(matched.route.access, 'actor')
      if (matched.route.access !== 'actor') assert.fail('expected authenticated asset route')
      const response = await matched.route.handler({
        actor: { id: ACTOR_ID, role: 'user' }, path, params: matched.params,
      } as AuthedContext)
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), { success: false, error: { code: 'INVALID_INPUT', message: '资产 ID 无效' } })
    }
    assert.equal(query.mock.callCount(), 0)
  } finally {
    query.mock.restore()
  }
})

test('library owned detail signs one bounded DTO and hides storage keys and private final prompt', async () => {
  const environment = {
    S3_ENDPOINT: 'https://storage.example.invalid', S3_PUBLIC_ENDPOINT: 'https://media.example.invalid',
    S3_REGION: 'fixture', S3_BUCKET: 'fixture', S3_ACCESS_KEY_ID: 'fixture-access-key',
    S3_SECRET_ACCESS_KEY: 'fixture-secret-key', S3_SIGNED_URL_TTL: '900',
  }
  const saved = new Map(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  const row = {
    id: ASSET_ID, object_key: 'private/detail.mp4', media_kind: 'video', mime_type: 'video/mp4',
    thumbnail_object_key: 'private/preview.png', poster_object_key: 'private/preview.png',
    input_prompt: 'user prompt', final_prompt: 'private final prompt', allow_user_read_final_prompt: false,
    width: 120, height: 80, size_bytes: 42, created_at: new Date('2026-01-02T03:04:05.000Z'),
  }
  let assetQueries = 0
  const query = mock.method(db(), 'query', async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('SELECT config_revision')) return { rows: [{ config_revision: 1 }] }
    if (!sql.startsWith('SELECT a.id')) return { rows: [] }
    assetQueries++
    assert.deepEqual(values, [ASSET_ID, ACTOR_ID])
    assert.match(sql, /LIMIT 1/)
    return { rows: [row] }
  })
  invalidateRuntimeSettings()
  try {
    const response = await getLibraryAsset({ actor: { id: ACTOR_ID, role: 'user' }, params: { id: ASSET_ID } } as unknown as AuthedContext)
    assert.equal(response.status, 200)
    const { data } = await response.json()
    assert.equal(assetQueries, 1)
    assert.equal(data.id, ASSET_ID)
    assert.equal(data.finalPrompt, null)
    assert.equal(data.canReadFinalPrompt, false)
    assert.equal(data.url, data.downloadUrl)
    assert.equal(data.thumbnailUrl, data.posterUrl)
    assert.equal('object_key' in data, false)
    for (const [url, key] of [[data.url, row.object_key], [data.thumbnailUrl, row.thumbnail_object_key]]) {
      const signed = new URL(url)
      assert.equal(signed.hostname, 'media.example.invalid')
      assert.equal(signed.pathname, `/fixture/${key}`)
      assert.ok(signed.searchParams.has('X-Amz-Signature'))
    }
  } finally {
    query.mock.restore()
    invalidateRuntimeSettings()
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
