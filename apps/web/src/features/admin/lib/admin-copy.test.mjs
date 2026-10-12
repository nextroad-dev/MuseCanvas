import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyAdminValue } from './admin-copy.ts'

test('copy copies the exact full explicit code or task ID, never a shortened display string', async () => {
  const written = []
  const clipboard = { writeText: async (value) => { written.push(value) } }
  await copyAdminValue('FULL-invite-code', clipboard)
  await copyAdminValue('12345678-1234-1234-1234-123456789abc', clipboard)
  assert.deepEqual(written, ['FULL-invite-code', '12345678-1234-1234-1234-123456789abc'])
})

test('missing invite code never falls back to record ID or calls the clipboard', async () => {
  let called = false
  await assert.rejects(copyAdminValue(undefined, { writeText: async () => { called = true } }), /明文/)
  assert.equal(called, false)
})

test('unavailable or rejected clipboard remains a failure so UI can offer selectable fallback', async () => {
  await assert.rejects(copyAdminValue('full-value'), /剪贴板不可用/)
  await assert.rejects(copyAdminValue('full-value', { writeText: async () => { throw new Error('denied') } }), /denied/)
})
