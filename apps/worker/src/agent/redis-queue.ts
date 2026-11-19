import { createBlockingRedis, consumer, redis, redisCommand, HEARTBEAT_TTL_MS, STALE_PENDING_IDLE_MS, CONSUMER_BLOCK_MS } from '../shared/infra'
import { AGENT_STREAM, AGENT_MEDIA_EVENT_STREAM, AGENT_CONSUMER_GROUP, AGENT_MEDIA_CONSUMER_GROUP } from '../queue/outbox-routing'
export { AGENT_CONSUMER_GROUP, AGENT_MEDIA_CONSUMER_GROUP } from '../queue/outbox-routing'
import type { AgentConsumerQueue, AgentStreamMessage } from './consumer'

export function createAgentRedisQueue(kind: 'turn'|'media'): AgentConsumerQueue {
  // Each consumer owns its blocking connection; generation reads/heartbeats
  // and this consumer's Redis writes never wait behind its XREADGROUP.
  const blocking = createBlockingRedis()
  blocking.on('error',()=>console.error('agent redis connection error',{code:'AGENT_REDIS_ERROR'}))
  const stream = kind === 'turn' ? AGENT_STREAM : AGENT_MEDIA_EVENT_STREAM
  const group = kind === 'turn' ? AGENT_CONSUMER_GROUP : AGENT_MEDIA_CONSUMER_GROUP
  const heartbeatKey = (id: string) => `hb:${group}:${id}`
  return {
    async initialize() {
      if (!blocking.isOpen) await redisCommand(blocking.connect())
      try { await redisCommand(redis.xGroupCreate(stream,group,'0',{MKSTREAM:true})) }
      catch (error) { if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error }
    },
    async read(count) {
      const reply=await redisCommand(blocking.xReadGroup(group,consumer,{key:stream,id:'>'},{COUNT:count,BLOCK:CONSUMER_BLOCK_MS}),CONSUMER_BLOCK_MS+10_000)
      const streams=reply as unknown as Array<{messages:AgentStreamMessage[]}> | null
      return (streams ?? []).flatMap(entry=>entry.messages)
    },
    async reclaim(cursor,count) {
      const result=await redisCommand(redis.xAutoClaim(stream,group,consumer,STALE_PENDING_IDLE_MS,cursor,{COUNT:count}))
      return {cursor:result.nextId,messages:result.messages.filter((entry): entry is NonNullable<typeof entry> => entry!==null) as AgentStreamMessage[]}
    },
    heartbeatExists: id=>redisCommand(redis.exists(heartbeatKey(id))).then(count=>count>0),
    heartbeat: id=>redisCommand(redis.set(heartbeatKey(id),'1',{expiration:{type:'PX',value:HEARTBEAT_TTL_MS}})).then(()=>undefined),
    ack: id=>redisCommand(redis.xAck(stream,group,id)).then(()=>undefined),
    close:()=>{if(blocking.isOpen)blocking.destroy()},
  }
}
