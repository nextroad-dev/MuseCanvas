import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deleteSelectedAssets, libraryGridClass } from './workspace-page-state.ts'

test('desktop density always degrades to one readable column on narrow screens', () => {
  for (const columns of [2, 3, 4, 6]) {
    assert.match(libraryGridClass(columns), /^grid-cols-1 /)
    assert.match(libraryGridClass(columns), /sm:grid-cols-2/)
  }
  assert.equal(libraryGridClass(2), 'grid-cols-1 sm:grid-cols-2')
  assert.match(libraryGridClass(3), /md:grid-cols-3/)
  assert.match(libraryGridClass(4), /md:grid-cols-4/)
  assert.match(libraryGridClass(6), /md:grid-cols-4 lg:grid-cols-6/)
})

test('partial deletion reports successful IDs and preserves only failed targets for retry', async () => {
  const targets = ['a', 'b', 'c']
  const result = await deleteSelectedAssets(targets, async (id) => {
    if (id === 'b') throw new Error('temporary failure')
  })
  assert.deepEqual(result, { succeeded: ['a', 'c'], failed: ['b'] })
  assert.deepEqual(targets, ['a', 'b', 'c'])
  assert.deepEqual(await deleteSelectedAssets(result.failed, async () => {}), { succeeded: ['b'], failed: [] })
})

test('all failed and empty deletion batches have honest outcomes', async () => {
  assert.deepEqual(await deleteSelectedAssets(['a', 'b'], async () => { throw new Error('offline') }), { succeeded: [], failed: ['a', 'b'] })
  assert.deepEqual(await deleteSelectedAssets([], async () => { assert.fail('no request expected') }), { succeeded: [], failed: [] })
})

test('an early failure does not finalize selection before other requests settle', async () => {
  let finish
  let settled = false
  const pending = deleteSelectedAssets(['a', 'b'], (id) => id === 'a'
    ? Promise.reject(new Error('failed'))
    : new Promise((resolve) => { finish = resolve }))
  pending.then(() => { settled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  finish()
  assert.deepEqual(await pending, { succeeded: ['b'], failed: ['a'] })
})
