import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAdminActionLock, isAdminToggleBlocked } from './admin-action-state.ts'

test('active toggle keeps its native Switch enabled while the synchronous object lock rejects repeats/conflicts', () => {
  const lock = createAdminActionLock()
  assert.equal(lock.claim('model-a', 'toggle'), true)
  assert.equal(isAdminToggleBlocked(lock.kind('model-a')), false)
  assert.equal(isAdminToggleBlocked(lock.kind('model-a'), true), false)
  assert.equal(lock.claim('model-a', 'toggle'), false)
  assert.equal(lock.claim('model-a', 'delete'), false)
  assert.equal(lock.claim('model-a', 'test'), false)
  assert.equal(lock.claim('model-b', 'delete'), true)
  assert.equal(isAdminToggleBlocked(lock.kind('model-b')), true)
  lock.release('model-a')
  assert.equal(lock.kind('model-a'), undefined)
})

test('delete/test and externally pending credential tests still block the conflicting toggle', () => {
  const lock = createAdminActionLock()
  for (const kind of ['delete', 'test', 'other']) {
    assert.equal(lock.claim('credential', kind), true)
    assert.equal(isAdminToggleBlocked(lock.kind('credential')), true)
    lock.release('credential')
  }
  assert.equal(isAdminToggleBlocked(undefined, true), true)
  assert.equal(isAdminToggleBlocked(undefined, false), false)
})

test('object action lock prevents duplicate and conflicting actions while allowing unrelated objects', () => {
  const lock = createAdminActionLock()
  assert.equal(lock.claim('model-a'), true)
  assert.equal(lock.claim('model-a'), false)
  assert.equal(lock.claim('model-b'), true)
  lock.release('model-a')
  assert.equal(lock.has('model-b'), true)
  assert.equal(lock.claim('model-a'), true)
})

test('shared template lock remains claimed through asynchronous catalog refresh', async () => {
  const lock = createAdminActionLock()
  const key = 'active-template-set'
  let resolveRefresh
  const refresh = new Promise((resolve) => { resolveRefresh = resolve })
  assert.equal(lock.claim(key), true)
  const deletion = (async () => {
    try {
      await refresh
    } finally {
      lock.release(key)
    }
  })()
  assert.equal(lock.claim(key), false)
  resolveRefresh()
  await deletion
  assert.equal(lock.claim(key), true)
})

test('failed request releases its object lock for retry without releasing other objects', async () => {
  const lock = createAdminActionLock()
  lock.claim('credential-a')
  lock.claim('credential-b')
  await assert.rejects((async () => {
    try {
      throw new Error('request failed')
    } finally {
      lock.release('credential-a')
    }
  })(), /request failed/)
  assert.equal(lock.claim('credential-a'), true)
  assert.equal(lock.has('credential-b'), true)
})
