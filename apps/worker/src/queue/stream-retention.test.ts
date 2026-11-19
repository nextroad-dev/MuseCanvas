import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { agentRetentionConfig, createAgentRetentionMonitor, trimAgentStreams, runStreamRetentionSweep, TRIM_AGENT_STREAM_LUA } from './stream-retention'
import { AGENT_STREAM, AGENT_MEDIA_EVENT_STREAM, AGENT_CONSUMER_GROUP, AGENT_MEDIA_CONSUMER_GROUP } from './outbox-routing'

const enabled = { AGENT_STREAM_RETENTION_ENABLED: 'true', AGENT_STREAM_RETENTION_SECONDS: '3600', AGENT_STREAM_TRIM_BATCH_SIZE: '100' }

test('Agent retention is opt-in and rejects missing, partial or malformed deletion configuration', async () => {
  for (const env of [{}, { ...enabled, AGENT_STREAM_RETENTION_ENABLED: 'TRUE' }, { AGENT_STREAM_RETENTION_ENABLED: 'true' }, ...['0', '-1', '1.5', ' 60', '31536001'].map(value => ({ ...enabled, AGENT_STREAM_RETENTION_SECONDS: value })), { ...enabled, AGENT_STREAM_TRIM_BATCH_SIZE: '10001' }]) {
    let evaluations = 0
    const results = await trimAgentStreams({ async eval() { evaluations += 1; return [] } }, env, createAgentRetentionMonitor())
    assert.equal(evaluations, 0)
    assert.ok(results.every(row => row.removed === 0 && ['disabled', 'invalid-config'].includes(row.reason)))
  }
  assert.deepEqual(agentRetentionConfig(enabled), { seconds: 3600, batch: 100 })
})

test('Agent trim uses the static stream/group allowlist and exports bounded metrics with unknown gauges omitted', async () => {
  const calls: Array<{ keys: string[]; arguments: string[] }> = []
  const monitor = createAgentRetentionMonitor()
  const results = await trimAgentStreams({ async eval(script, options) {
    assert.match(script, /redis.call\('TIME'\)/)
    assert.match(script, /XPENDING/)
    assert.match(script, /#groups~=1/)
    assert.match(script, /'COUNT',ARGV\[3\]/)
    calls.push(options)
    return calls.length === 1 ? [2, 'trimmed', 10, 1, 5000] : [0, 'unexpected-group', 8, -1, -1]
  } }, enabled, monitor)
  assert.deepEqual(calls.map(call => call.keys), [[AGENT_STREAM], [AGENT_MEDIA_EVENT_STREAM]])
  assert.deepEqual(calls.map(call => call.arguments), [[AGENT_CONSUMER_GROUP, '3600', '100'], [AGENT_MEDIA_CONSUMER_GROUP, '3600', '100']])
  assert.equal(results[1]!.pending, null)
  const metrics = monitor.render()
  assert.match(metrics, /agent_stream_trim_deleted_total\{kind="turn"\} 2/)
  assert.match(metrics, /agent_stream_oldest_pending_age_seconds\{kind="turn"\} 5/)
  assert.doesNotMatch(metrics, /agent_stream_pending\{kind="media"\}/)
  assert.doesNotMatch(metrics, /sessionId|ownerId|objectKey|eventId/)
})

test('Redis failures become metrics without blocking another stream or consumers', async () => {
  const monitor = createAgentRetentionMonitor()
  const results = await trimAgentStreams({ async eval() { throw new Error('synthetic failure') } }, enabled, monitor)
  assert.ok(results.every(row => row.reason === 'error' && row.removed === 0))
  assert.match(monitor.render(), /agent_stream_trim_errors_total\{kind="media"\} 1/)
})

test('generation retention failure still runs both Agent streams and updates metrics', async () => {
  const monitor = createAgentRetentionMonitor()
  const errors: string[] = []
  let calls = 0
  await runStreamRetentionSweep({
    generation: async () => { throw new Error('invalid generation trim batch') },
    agent: () => trimAgentStreams({ eval: async () => { calls += 1; return [0, 'no-eligible', 3, 0, 0] } }, enabled, monitor),
    onError: kind => { errors.push(kind) },
  })
  assert.deepEqual(errors, ['generation'])
  assert.equal(calls, 2)
  assert.match(monitor.render(), /agent_stream_length\{kind="turn"\} 3/)
  assert.match(monitor.render(), /agent_stream_trim_skipped_total\{kind="media",reason="no-eligible"\} 1/)
})

test('Lua metadata queries are structurally bounded and the zero cursor exits before XRANGE', () => {
  const script = TRIM_AGENT_STREAM_LUA
  assert.ok(script.indexOf("if info['groups']~=1") < script.indexOf("redis.call('XINFO','GROUPS'"))
  assert.match(script, /redis.call\('XPENDING',KEYS\[1\],ARGV\[1\],'-','\+',1\)/)
  assert.doesNotMatch(script, /redis.call\('XPENDING',KEYS\[1\],ARGV\[1\]\)/)
  assert.ok(script.indexOf("if boundary=='0-0' then return") < script.indexOf("redis.call('XRANGE'"))
})

test('every Compose variant keeps Agent stream deletion disabled until all settings are supplied', () => {
  for (const file of ['compose.yaml', 'compose.dev.yaml', 'compose.prod.yaml', 'compose.images.yaml']) {
    const source = readFileSync(new URL(`../../../../deploy/${file}`, import.meta.url), 'utf8')
    assert.ok(source.includes('AGENT_STREAM_RETENTION_ENABLED: ${AGENT_STREAM_RETENTION_ENABLED:-false}'))
    assert.ok(source.includes('AGENT_STREAM_RETENTION_SECONDS: ${AGENT_STREAM_RETENTION_SECONDS:-0}'))
    assert.ok(source.includes('AGENT_STREAM_TRIM_BATCH_SIZE: ${AGENT_STREAM_TRIM_BATCH_SIZE:-0}'))
  }
})
