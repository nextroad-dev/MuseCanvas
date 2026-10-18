import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkerHealth } from './health'

test('worker readiness requires queue and scheduler progress and expires independently', () => {
  let now = 0
  const health = createWorkerHealth(() => now)
  assert.equal(health.ready(), false)
  health.queueProgress()
  assert.equal(health.ready(), false)
  health.scheduleProgress()
  assert.equal(health.ready(), true)
  now = 60_000
  assert.equal(health.ready(), false, 'a stalled scheduler fails readiness even with a live queue')
  health.scheduleProgress()
  assert.equal(health.ready(), true)
  now = 120_000
  health.scheduleProgress()
  assert.equal(health.ready(), false, 'a stalled consumer fails readiness even with a live scheduler')
  health.queueProgress()
  assert.equal(health.ready(), true)
})
