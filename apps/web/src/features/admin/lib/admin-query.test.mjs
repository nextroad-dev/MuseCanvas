import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { adminJobDetailValues, adminJobErrorSummary, invitationStatus, requireAdminData } from './admin-query.ts'

test('requireAdminData rejects failed envelopes even if data is present', () => {
  assert.throws(
    () => requireAdminData({ success: false, data: [], error: { code: 'FORBIDDEN', message: '拒绝访问' } }, '加载失败'),
    (error) => error.message === '拒绝访问' && error.code === 'FORBIDDEN',
  )
})

test('requireAdminData rejects missing data rather than treating it as an empty success', () => {
  for (const response of [{ success: true }, { success: false }, { success: true, data: null }]) {
    assert.throws(() => requireAdminData(response, '加载失败'), /加载失败/)
  }
  assert.deepEqual(requireAdminData({ success: true, data: [] }, '加载失败'), [])
})

test('requireAdminData preserves total and cursor metadata without substituting batch length', () => {
  const page = { items: [{ id: 'user' }], total: 120, hasMore: true, nextCursor: 'cursor' }
  assert.strictEqual(requireAdminData({ success: true, data: page }, '加载失败'), page)
})

test('Query first failure is an error without cached data', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    await assert.rejects(client.fetchQuery({ queryKey: ['admin', 'users'], queryFn: async () => requireAdminData({ success: false }, '加载失败') }))
    const state = client.getQueryState(['admin', 'users'])
    assert.equal(state.status, 'error')
    assert.equal(state.data, undefined)
  } finally {
    client.clear()
  }
})

test('Query refresh failure retains the previous successful batch, including empty batches', async () => {
  for (const items of [[], [{ id: 'job' }]]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = ['admin', 'jobs']
    const page = { items, total: items.length, hasMore: false }
    try {
      await client.fetchQuery({ queryKey: key, queryFn: async () => requireAdminData({ success: true, data: page }, '加载失败') })
      await assert.rejects(client.fetchQuery({ queryKey: key, queryFn: async () => requireAdminData({ success: false }, '刷新失败') }))
      assert.strictEqual(client.getQueryData(key), page)
      assert.equal(client.getQueryState(key).status, 'error')
    } finally {
      client.clear()
    }
  }
})

test('job error summary exposes only an error token and valid HTTP status', () => {
  assert.equal(adminJobErrorSummary({ errorCode: 'PROVIDER_TIMEOUT', providerError: { status: 504, detail: 'private prompt', endpoint: 'secret-url', credentials: 'private key' } }), 'PROVIDER_TIMEOUT · 供应商 HTTP 504')
  assert.equal(adminJobErrorSummary({ providerError: { detail: 'private prompt' } }), '供应商错误（无安全摘要）')
  assert.equal(adminJobErrorSummary({ errorCode: 'private prompt', providerError: { status: 'secret' } }), '错误代码不可用')
  for (const status of [NaN, 0, 600, 503.5]) {
    assert.equal(adminJobErrorSummary({ providerError: { status } }), '供应商错误（无安全摘要）')
  }
  assert.equal(adminJobErrorSummary({}), '')
})

test('job details preserve full desktop fields but exclude raw prompts, credentials and media URLs', () => {
  const details = adminJobDetailValues({
    id: 'full-task-id', createdBy: 'full-user-id', modelId: 'model-id', modelName: 'model name',
    status: 'failed', createdAt: '2026-10-06T00:00:00Z', errorCode: 'PROVIDER_TIMEOUT',
    providerError: { status: 504, endpoint: 'private endpoint', detail: 'private prompt', credentials: 'private secret' },
    prompt: 'private prompt', resultUrl: 'private media', storageKey: 'private object',
  })
  assert.deepEqual(details, {
    id: 'full-task-id', createdBy: 'full-user-id', modelId: 'model-id', modelName: 'model name',
    status: 'failed', createdAt: '2026-10-06T00:00:00Z', errorSummary: 'PROVIDER_TIMEOUT · 供应商 HTTP 504',
  })
  assert.equal(JSON.stringify(details).includes('private'), false)
})

test('an unused invitation without expiry information is never labeled valid', () => {
  assert.deepEqual(invitationStatus({ used: false }), { label: '未使用，期限未知', tone: 'neutral' })
  assert.equal(invitationStatus({ used: true }).label, '已使用')
  assert.equal(invitationStatus({ used: false, revoked: true }).label, '已撤销')
})
