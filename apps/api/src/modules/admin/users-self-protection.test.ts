import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import type { AuthedContext } from '../../router/types'
import { deleteUser, setUserStatus } from './users'

const actorId = 'abcdef12-3456-7890-abcd-ef1234567890'
const context = (id: string): AuthedContext => ({
  request: new NextRequest('https://example.invalid/api/admin/users/' + id),
  actor: { id: actorId, role: 'admin', status: 'active', email: 'admin@example.invalid', createdAt: '2026-01-01T00:00:00Z' },
  path: 'admin/users/' + id, params: { id }, json: async () => ({ status: 'disabled' }),
})

for (const [name, handler] of [['disable', setUserStatus], ['delete', deleteUser]] as const) {
  for (const id of [actorId, actorId.toUpperCase()]) {
    test(`${name} rejects canonical self ID before database/session mutations: ${id}`, async () => {
      const response = await handler(context(id))
      assert.equal(response.status, 400)
      assert.equal((await response.json()).error.code, 'INVALID_OPERATION')
    })
  }

  for (const id of [actorId.replaceAll('-', ''), actorId.replace('-', ''), 'a', '------------------------------------', '{' + actorId + '}']) {
    test(`${name} rejects noncanonical UUID before database/session mutations: ${id}`, async () => {
      const response = await handler(context(id))
      assert.equal(response.status, 400)
      assert.equal((await response.json()).error.code, 'INVALID_INPUT')
    })
  }
}
