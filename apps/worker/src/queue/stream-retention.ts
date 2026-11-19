import { AGENT_STREAM, AGENT_MEDIA_EVENT_STREAM, AGENT_CONSUMER_GROUP, AGENT_MEDIA_CONSUMER_GROUP } from './outbox-routing'

type StreamKind = 'turn' | 'media'
export type RetentionReason = 'disabled' | 'invalid-config' | 'missing-key' | 'no-group' | 'unexpected-group' | 'trimmed' | 'no-eligible' | 'error'
export interface RetentionResult { kind: StreamKind; removed: number; reason: RetentionReason; length: number | null; pending: number | null; oldestPendingAgeMs: number | null }
export interface RetentionRedisPort { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> }
const streams = [
  { kind: 'turn' as const, stream: AGENT_STREAM, group: AGENT_CONSUMER_GROUP },
  { kind: 'media' as const, stream: AGENT_MEDIA_EVENT_STREAM, group: AGENT_MEDIA_CONSUMER_GROUP },
]
const reasons: RetentionReason[] = ['disabled', 'invalid-config', 'missing-key', 'no-group', 'unexpected-group', 'trimmed', 'no-eligible', 'error']

export function agentRetentionConfig(env: NodeJS.ProcessEnv): { reason: 'disabled' | 'invalid-config' } | { seconds: number; batch: number } {
  if (env.AGENT_STREAM_RETENTION_ENABLED !== 'true') return { reason: 'disabled' as const }
  const parse = (value: string | undefined, max: number) => value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= max ? Number(value) : null
  const seconds = parse(env.AGENT_STREAM_RETENTION_SECONDS, 31_536_000)
  const batch = parse(env.AGENT_STREAM_TRIM_BATCH_SIZE, 10_000)
  return seconds && batch ? { seconds, batch } : { reason: 'invalid-config' as const }
}

// Redis 7+: server time and the group/PEL/deletion boundary are observed atomically.
// IDs compare as decimal strings, including sequence values beyond Lua double precision.
export const TRIM_AGENT_STREAM_LUA = `
local function lt(a,b)
  local am,as=string.match(a,'^(%d+)%-(%d+)$'); local bm,bs=string.match(b,'^(%d+)%-(%d+)$')
  if #am~=#bm then return #am<#bm end
  if am~=bm then return am<bm end
  if #as~=#bs then return #as<#bs end
  return as<bs
end
if redis.call('EXISTS',KEYS[1])==0 then return {0,'missing-key',0,0,0} end
local info={}; local stream=redis.call('XINFO','STREAM',KEYS[1])
for i=1,#stream,2 do info[stream[i]]=stream[i+1] end
local length=info['length']
if info['groups']==0 then return {0,'no-group',length,-1,-1} end
if info['groups']~=1 then return {0,'unexpected-group',length,-1,-1} end
local groups=redis.call('XINFO','GROUPS',KEYS[1])
if #groups~=1 then return {0,'unexpected-group',length,-1,-1} end
local group={}; for i=1,#groups[1],2 do group[groups[1][i]]=groups[1][i+1] end
if group['name']~=ARGV[1] then return {0,'unexpected-group',length,-1,-1} end
local time=redis.call('TIME'); local now=tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
local boundary=string.format('%.0f',math.max(0,now-tonumber(ARGV[2])*1000))..'-0'
if lt(group['last-delivered-id'],boundary) then boundary=group['last-delivered-id'] end
local pending=group['pending']
local age=0
if pending>0 then
  local first=redis.call('XPENDING',KEYS[1],ARGV[1],'-','+',1)
  if #first~=1 then return {0,'error',length,pending,-1} end
  local id=first[1][1]
  if lt(id,boundary) then boundary=id end
  age=math.max(0,now-tonumber(string.match(id,'^(%d+)%-')))
end
if boundary=='0-0' then return {0,'no-eligible',length,pending,age} end
local rows=redis.call('XRANGE',KEYS[1],'-','('..boundary,'COUNT',ARGV[3])
local removed=0
for _,row in ipairs(rows) do removed=removed+redis.call('XDEL',KEYS[1],row[1]) end
return {removed,removed>0 and 'trimmed' or 'no-eligible',length-removed,pending,age}
`

/** Each retention lane reports its own failure; a generation failure cannot suppress Agent maintenance. */
export async function runStreamRetentionSweep(ports: {
  generation: () => Promise<unknown>
  agent: () => Promise<unknown>
  onError: (kind: 'generation' | 'agent', error: unknown) => void
}): Promise<void> {
  for (const kind of ['generation', 'agent'] as const) {
    try { await ports[kind]() }
    catch (error) { ports.onError(kind, error) }
  }
}

/** Fixed labels only; no event/session/user/object identifiers enter the metrics endpoint. */
export function createAgentRetentionMonitor() {
  const latest = new Map<StreamKind, RetentionResult>()
  const deleted = { turn: 0, media: 0 }, errors = { turn: 0, media: 0 }
  const skipped = new Map<string, number>()
  return {
    observe(result: RetentionResult) {
      latest.set(result.kind, result)
      deleted[result.kind] += result.removed
      if (result.reason === 'error') errors[result.kind] += 1
      else if (result.reason !== 'trimmed') {
        const key = `${result.kind}:${result.reason}`
        skipped.set(key, (skipped.get(key) ?? 0) + 1)
      }
    },
    render(): string {
      const lines = ['# TYPE agent_stream_trim_deleted_total counter', '# TYPE agent_stream_trim_errors_total counter', '# TYPE agent_stream_trim_skipped_total counter', '# TYPE agent_stream_length gauge', '# TYPE agent_stream_pending gauge', '# TYPE agent_stream_oldest_pending_age_seconds gauge']
      for (const { kind } of streams) {
        lines.push(`agent_stream_trim_deleted_total{kind="${kind}"} ${deleted[kind]}`, `agent_stream_trim_errors_total{kind="${kind}"} ${errors[kind]}`)
        const sample = latest.get(kind)
        if (sample?.length != null) lines.push(`agent_stream_length{kind="${kind}"} ${sample.length}`)
        if (sample?.pending != null) lines.push(`agent_stream_pending{kind="${kind}"} ${sample.pending}`)
        if (sample?.oldestPendingAgeMs != null) lines.push(`agent_stream_oldest_pending_age_seconds{kind="${kind}"} ${sample.oldestPendingAgeMs / 1000}`)
        for (const reason of reasons) lines.push(`agent_stream_trim_skipped_total{kind="${kind}",reason="${reason}"} ${skipped.get(`${kind}:${reason}`) ?? 0}`)
      }
      return `${lines.join('\n')}\n`
    },
  }
}
const monitor = createAgentRetentionMonitor()
export const agentStreamRetentionMetrics = () => monitor.render()

export async function trimAgentStreams(port: RetentionRedisPort, env: NodeJS.ProcessEnv = process.env, observer = monitor): Promise<RetentionResult[]> {
  const config = agentRetentionConfig(env)
  const results: RetentionResult[] = []
  for (const { kind, stream, group } of streams) {
    let result: RetentionResult = { kind, removed: 0, reason: 'reason' in config ? config.reason : 'error', length: null, pending: null, oldestPendingAgeMs: null }
    if (!('reason' in config)) {
      try {
        const reply = await port.eval(TRIM_AGENT_STREAM_LUA, { keys: [stream], arguments: [group, String(config.seconds), String(config.batch)] })
        if (!Array.isArray(reply) || reply.length !== 5 || !reasons.includes(reply[1] as RetentionReason)) throw new Error('INVALID_RETENTION_REPLY')
        const numbers = [reply[0], reply[2], reply[3], reply[4]].map(Number)
        if (numbers.some(value => !Number.isSafeInteger(value) || value < -1) || numbers[0]! < 0 || numbers[0]! > config.batch) throw new Error('INVALID_RETENTION_REPLY')
        result = { kind, removed: numbers[0]!, reason: reply[1] as RetentionReason, length: numbers[1]! < 0 ? null : numbers[1]!, pending: numbers[2]! < 0 ? null : numbers[2]!, oldestPendingAgeMs: numbers[3]! < 0 ? null : numbers[3]! }
      } catch { result.reason = 'error' }
    }
    observer.observe(result)
    results.push(result)
  }
  return results
}
