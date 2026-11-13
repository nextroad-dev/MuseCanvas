import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTs } from './mock-workspace-test-loader.mjs'

test('client API redirects only workspace methods and never falls through on mock rejection', async () => {
  const live = []
  const mocked = []
  const error = Error('unsupported demo input')
  const workspace = Object.fromEntries(Object.entries({
    models: ['list'], generations: ['create'], jobs: ['list', 'detail', 'cancel', 'retry', 'remove'], library: ['list', 'download', 'remove'],
  }).map(([group, names]) => [group, Object.fromEntries(names.map((method) => [method, async (...args) => {
    mocked.push([group, method, args])
    if (group === 'generations') throw error
    return { demo: true }
  }]))]))
  const endpoints = {
    session: '/session', models: '/models', generations: '/generations',
    media: { object: '/media/object', upload: '/media/upload' },
    generationUploads: { create: '/uploads' },
  }
  const imports = {
    '@musecanvas/contracts': { API_ENDPOINTS: endpoints },
    './api': { apiFetch: async (...args) => { live.push(args); return { live: true } } },
    '../lib/workspace-mode': { WORKSPACE_MODE: 'mock' },
    './mock-workspace-api': { mockWorkspaceApi: workspace },
  }
  const { clientApi } = loadTs(new URL('./client-api.ts', import.meta.url), imports)
  await clientApi.models.list()
  await assert.rejects(clientApi.generations.create({ modelId: 'video' }), error)
  for (const method of ['list', 'detail', 'cancel', 'retry', 'remove']) await clientApi.jobs[method]('id')
  for (const method of ['list', 'download', 'remove']) await clientApi.library[method]('id')
  assert.equal(mocked.length, 10)
  assert.equal(live.length, 0)
  await clientApi.session.get()
  await clientApi.generationUploads.create({ mimeType: 'image/png', sizeBytes: 10 })
  assert.equal(live.length, 2)
  assert.equal(live[0][0], '/session')
  assert.equal(live[1][0], '/uploads')

  const liveClient = loadTs(new URL('./client-api.ts', import.meta.url), {
    ...imports, '../lib/workspace-mode': { WORKSPACE_MODE: 'live' },
  }).clientApi
  await liveClient.models.list()
  await liveClient.generations.create({ modelId: 'real' })
  assert.equal(mocked.length, 10)
  assert.equal(live.length, 4)
})
