import assert from 'node:assert/strict'
import test from 'node:test'
import { createDrainingSweep } from './draining-sweep'

test('sweep abort stops new scheduling while drain waits for the active durable sweep', async () => {
  const controller = new AbortController()
  let finish!: () => void
  let calls = 0
  const order: string[] = []
  const sweep = createDrainingSweep(controller.signal, async () => {
    calls++; order.push('start')
    await new Promise<void>(resolve => { finish = resolve })
    order.push('commit')
  })
  const first = sweep.run()
  await Promise.resolve()
  assert.equal(sweep.run(), first)
  controller.abort()
  await sweep.run()
  let drained = false
  const closing = sweep.drain().then(() => { drained = true; order.push('teardown') })
  await Promise.resolve()
  assert.equal(drained, false)
  assert.equal(calls, 1)
  finish()
  await closing
  assert.deepEqual(order, ['start', 'commit', 'teardown'])
  await sweep.run()
  assert.equal(calls, 1)
})

test('abort before sweep callback starts prevents any durable work', async () => {
  const controller = new AbortController()
  let calls = 0
  const sweep = createDrainingSweep(controller.signal, async () => { calls++ })
  const pending = sweep.run()
  controller.abort()
  await pending
  await sweep.drain()
  assert.equal(calls, 0)
})
