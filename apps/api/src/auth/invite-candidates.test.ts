import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { findActiveInvitationHash } from './invitations'

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-with-enough-entropy'
process.env.APP_MASTER_KEY = process.env.APP_MASTER_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

test('legacy invitation lookup uses all candidates and returns the exact stored hash', async () => {
  const code = 'legacy-invite-code-123'
  const legacy = createHash('sha256').update(`${process.env.SESSION_SECRET}:${code}`).digest('hex')
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const client = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params })
      return { rows: [{ id: 'inv-1', code_hash: legacy }] }
    },
  }

  assert.equal(await findActiveInvitationHash(client, code), legacy)
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /code_hash = ANY\(\$1\)/)
  assert.ok((calls[0].params[0] as string[]).includes(legacy))
})

test('invitation lookup returns null when no active candidate matches', async () => {
  const client = { async query() { return { rows: [] } } }
  assert.equal(await findActiveInvitationHash(client, 'missing-code'), null)
})
