import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { agentCoreAdmissionReady, agentCoreEnabled, agentCorePathDisabled, agentCoreRolloutBucket } from './feature'

const flagKeys = ['AGENT_CORE_ENABLED', 'AGENT_CORE_ADMISSION_READY', 'AGENT_ADMISSION_PERCENT', 'AGENT_ADMISSION_ACTORS'] as const
function flags(t: TestContext, values: Partial<Record<typeof flagKeys[number], string>> = {}) {
  for (const key of flagKeys) {
    const before = process.env[key]
    const value = values[key]
    if (value === undefined) delete process.env[key]; else process.env[key] = value
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before })
  }
}
const actors = Array.from({ length: 200 }, (_, i) => `actor:${i}`)

test('agent rollout: deployment readiness accepts only exact true', t => {
  flags(t)
  assert.equal(agentCoreAdmissionReady('rollout-actor'), false)
  for (const value of ['false', 'TRUE', 'True', '1', '', ' true', 'true ']) {
    process.env.AGENT_CORE_ADMISSION_READY = value
    assert.equal(agentCoreAdmissionReady('rollout-actor'), false, JSON.stringify(value))
  }
  process.env.AGENT_CORE_ADMISSION_READY = 'true'
  assert.equal(agentCoreAdmissionReady('rollout-actor'), true)
})

test('agent rollout: an unset percent preserves full admission once ready', t => {
  flags(t, { AGENT_CORE_ADMISSION_READY: 'true' })
  for (const actorId of actors) assert.equal(agentCoreAdmissionReady(actorId), true)
})

test('agent rollout: zero percent admits nobody without an allowlist', t => {
  flags(t, { AGENT_CORE_ADMISSION_READY: 'true', AGENT_ADMISSION_PERCENT: '0' })
  for (const actorId of actors) assert.equal(agentCoreAdmissionReady(actorId), false)
})

test('agent rollout: one hundred percent admits every actor', t => {
  flags(t, { AGENT_CORE_ADMISSION_READY: 'true', AGENT_ADMISSION_PERCENT: '100' })
  for (const actorId of actors) assert.equal(agentCoreAdmissionReady(actorId), true)
})

test('agent rollout: present malformed or out-of-range percentages fail closed', t => {
  flags(t, { AGENT_CORE_ADMISSION_READY: 'true' })
  for (const value of ['-1', '101', 'abc', '', ' ', '50.5', '1e2', '0x64', '+100', '100 ', ' 100', '100\n', 'NaN', 'Infinity']) {
    process.env.AGENT_ADMISSION_PERCENT = value
    for (const actorId of actors) assert.equal(agentCoreAdmissionReady(actorId), false, JSON.stringify(value))
  }
})

test('agent rollout: buckets are deterministic integers from zero through ninety-nine', () => {
  for (const actorId of actors) {
    const bucket = agentCoreRolloutBucket(actorId)
    assert.equal(bucket, agentCoreRolloutBucket(actorId))
    assert.equal(Number.isInteger(bucket), true)
    assert.ok(bucket >= 0 && bucket <= 99)
  }
  // SHA-256("rollout-actor") starts with f218867b: unsigned big-endian 4061693563 % 100 = 63.
  assert.equal(agentCoreRolloutBucket('rollout-actor'), 63)
})

test('agent rollout: admission uses the exclusive percentage threshold for the actor bucket', t => {
  flags(t, { AGENT_CORE_ADMISSION_READY: 'true', AGENT_ADMISSION_PERCENT: '63' })
  assert.equal(agentCoreAdmissionReady('rollout-actor'), false)
  process.env.AGENT_ADMISSION_PERCENT = '64'
  assert.equal(agentCoreAdmissionReady('rollout-actor'), true)
})

test('agent rollout: trimmed valid allowlist entries bypass zero percent and malformed entries are ignored', t => {
  const allowed = ['Actor:allowed_01-A.z', 'x'.repeat(128), 'a']
  const malformed = ['bad actor', 'bad/actor', 'bad@actor', 'x'.repeat(129), '你好', 'bad\nactor', '*']
  flags(t, { AGENT_CORE_ADMISSION_READY: 'true', AGENT_ADMISSION_PERCENT: '0',
    AGENT_ADMISSION_ACTORS: ` ,\t${allowed.join(' , ')}\n, ,${malformed.join(',')},,` })
  for (const actorId of allowed) assert.equal(agentCoreAdmissionReady(actorId), true, actorId)
  for (const actorId of [...malformed, '', ' ', 'unlisted', allowed[0].toLowerCase()]) assert.equal(agentCoreAdmissionReady(actorId), false, actorId)
})

test('agent rollout: allowlist retains at most one thousand valid entries', t => {
  const allowed = Array.from({ length: 1001 }, (_, i) => `actor:${i}`)
  flags(t, { AGENT_CORE_ADMISSION_READY: 'true', AGENT_ADMISSION_PERCENT: '0',
    AGENT_ADMISSION_ACTORS: `, ,invalid/actor,${allowed.join(',')}` })
  assert.equal(agentCoreAdmissionReady(allowed[0]), true)
  assert.equal(agentCoreAdmissionReady(allowed[999]), true)
  assert.equal(agentCoreAdmissionReady(allowed[1000]), false)
})

test('agent rollout: allowlist also bypasses a malformed percentage', t => {
  flags(t, { AGENT_CORE_ADMISSION_READY: 'true', AGENT_ADMISSION_PERCENT: 'invalid', AGENT_ADMISSION_ACTORS: 'rollout-actor' })
  assert.equal(agentCoreAdmissionReady('rollout-actor'), true)
  assert.equal(agentCoreAdmissionReady('unlisted'), false)
})

test('agent rollout: missing or false deployment readiness dominates the allowlist', t => {
  flags(t, { AGENT_ADMISSION_PERCENT: '0', AGENT_ADMISSION_ACTORS: 'rollout-actor' })
  assert.equal(agentCoreAdmissionReady('rollout-actor'), false)
  for (const value of ['false', 'TRUE', '1', '']) {
    process.env.AGENT_CORE_ADMISSION_READY = value
    assert.equal(agentCoreAdmissionReady('rollout-actor'), false)
  }
  process.env.AGENT_CORE_ADMISSION_READY = 'true'
  assert.equal(agentCoreAdmissionReady('rollout-actor'), true)
})

test('agent rollout: readiness, percent and allowlist never change namespace or retired Canvas gates', t => {
  flags(t, { AGENT_ADMISSION_ACTORS: 'rollout-actor' })
  for (const enabled of ['true', 'false', 'TRUE', '']) {
    process.env.AGENT_CORE_ENABLED = enabled
    for (const ready of ['true', 'false']) {
      process.env.AGENT_CORE_ADMISSION_READY = ready
      for (const percent of ['0', '100', 'invalid']) {
        process.env.AGENT_ADMISSION_PERCENT = percent
        assert.equal(agentCoreEnabled(), enabled === 'true')
        for (const path of ['agent', 'agent/sessions', 'agent/unknown', 'agent/turns/bad!', 'images/edit/preparations']) assert.equal(agentCorePathDisabled(path), enabled !== 'true')
        for (const path of ['canvas-agent/status', 'canvases/canvas-id/agent/messages', 'agents', 'agentx', 'images/edit', 'images/edit/preparations-extra']) assert.equal(agentCorePathDisabled(path), false)
      }
    }
  }
})
