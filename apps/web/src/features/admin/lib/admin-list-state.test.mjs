import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendAdminCursor, EMPTY_ADMIN_JOB_FILTERS, readAdminJobFilters, resolveAdminJobFilters, searchAdminInvitations, searchAdminPromptTemplates } from './admin-list-state.ts'

const uuid = '12345678-1234-1234-1234-123456789abc'

test('monitor URL initializes only supported filters, ignoring cursor and private/unrelated parameters', () => {
  const result = readAdminJobFilters(new URLSearchParams(`status=failed&userId=${uuid}&from=2026-10-06T01%3A00%3A00Z&cursor=opaque&prompt=private`))
  assert.equal(result.valid, true)
  assert.deepEqual(result.params, { status: 'failed', userId: uuid, from: '2026-10-06T01:00:00.000Z' })
  assert.equal(result.draft.status, 'failed')
  assert.equal(Date.parse(result.draft.from), Date.parse('2026-10-06T01:00:00Z'))
  assert.equal(readAdminJobFilters(new URLSearchParams('modelId=not-a-uuid')).valid, false)
})

test('template search matches full instruction text only in the supplied active-set entries', () => {
  const rows = [{ name: 'One', description: null, instruction: 'first lines\nthird line\nneedle beyond the preview' }, { name: 'Two', description: 'tag', instruction: 'other' }]
  assert.strictEqual(searchAdminPromptTemplates(rows, ''), rows)
  assert.deepEqual(searchAdminPromptTemplates(rows, ' NEEDLE '), [rows[0]])
  assert.deepEqual(searchAdminPromptTemplates(rows, 'tag'), [rows[1]])
  assert.deepEqual(searchAdminPromptTemplates(rows, 'older-set-entry'), [])
})

test('job filters contain only supported request parameters, with trimmed IDs and normalized dates', () => {
  const result = resolveAdminJobFilters({ status: 'failed', userId: ` ${uuid} `, modelId: uuid, from: '2026-10-06T01:00:00Z', to: '2026-10-06T02:00:00Z' })
  assert.equal(result.valid, true)
  assert.deepEqual(result.params, { status: 'failed', userId: uuid, modelId: uuid, from: '2026-10-06T01:00:00.000Z', to: '2026-10-06T02:00:00.000Z' })
  assert.deepEqual(resolveAdminJobFilters(EMPTY_ADMIN_JOB_FILTERS).params, {})
})

test('job filters reject malformed IDs, unsupported status and invalid or reversed time instead of silently applying nothing', () => {
  const invalid = resolveAdminJobFilters({ status: 'unsupported', userId: 'email@example.com', modelId: 'model-name', from: 'bad time', to: '' })
  assert.equal(invalid.valid, false)
  assert.deepEqual(Object.keys(invalid.errors).sort(), ['from', 'modelId', 'status', 'userId'])
  const reversed = resolveAdminJobFilters({ ...EMPTY_ADMIN_JOB_FILTERS, from: '2026-10-07T00:00:00Z', to: '2026-10-06T00:00:00Z' })
  assert.equal(reversed.valid, false)
  assert.ok(reversed.errors.to)
})

test('cursor histories only append an opaque next cursor from their current batch, rejecting duplicate/stale responses', () => {
  const first = [undefined]
  const next = appendAdminCursor(first, undefined, 'opaque-one')
  assert.deepEqual(next, [undefined, 'opaque-one'])
  assert.strictEqual(appendAdminCursor(next, undefined, 'stale-next'), next)
  assert.strictEqual(appendAdminCursor(next, 'opaque-one', 'opaque-one'), next)
  assert.strictEqual(appendAdminCursor(next, 'opaque-one', undefined), next)
  assert.deepEqual(appendAdminCursor(next, 'opaque-one', 'opaque-two'), [undefined, 'opaque-one', 'opaque-two'])
  assert.deepEqual(first, [undefined])
})

test('invitation search is case-insensitive and limited to supplied window, never inventing a missing code', () => {
  const rows = [{ id: 'legacy-id' }, { id: 'new-id', code: 'Invite-CODE' }]
  assert.strictEqual(searchAdminInvitations(rows, ''), rows)
  assert.deepEqual(searchAdminInvitations(rows, ' code '), [rows[1]])
  assert.deepEqual(searchAdminInvitations(rows, 'LEGACY'), [rows[0]])
  assert.deepEqual(searchAdminInvitations(rows, 'unknown-invite'), [])
})
