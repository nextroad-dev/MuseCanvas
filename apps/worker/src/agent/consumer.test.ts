import assert from 'node:assert/strict'
import test from 'node:test'
import { startAgentWorkers } from './boot'
import { consumeAgentStream, createAgentWakeHandler, superviseWorkerLoops, type AgentConsumerQueue, type AgentStreamMessage } from './consumer'
const fields={eventId:'10000000-0000-4000-8000-000000000001',sessionId:'20000000-0000-4000-8000-000000000001',turnId:'30000000-0000-4000-8000-000000000001',revision:'1'}
const msg=(id:string):AgentStreamMessage=>({id,message:fields})
function queue() {
  const controller=new AbortController();const acks:string[]=[];const beats:string[]=[];const counts:number[]=[];let reads=0,closed=false
  const port:AgentConsumerQueue={async initialize(){},async read(count){counts.push(count);if(reads++===0)return [msg('1')];controller.abort();return []},async reclaim(){return {cursor:'0-0',messages:[]}},async heartbeatExists(){return false},async heartbeat(id){beats.push(id)},async ack(id){acks.push(id)},close(){closed=true}}
  return {port,controller,acks,beats,counts,get closed(){return closed}}
}
test('consumer: ACK follows successful durable runner completion and heartbeat precedes work',async()=>{
  const f=queue();let durable=false;f.port.ack=async id=>{assert.ok(durable);f.acks.push(id)}
  await consumeAgentStream(f.port,async()=>{assert.deepEqual(f.beats,['1']);durable=true;return 'ack'},{signal:f.controller.signal,concurrency:1});assert.deepEqual(f.acks,['1']);assert.ok(f.closed)
})
test('consumer: throw/retry leaves message pending with no ACK',async()=>{
  for(const outcome of ['throw','retry']){const f=queue();await consumeAgentStream(f.port,async()=>{if(outcome==='throw')throw new Error('secret upstream');return 'retry'},{signal:f.controller.signal,concurrency:1});assert.deepEqual(f.acks,[])}
})
test('consumer: shutdown during a blocking read never ACKs or schedules returned pending messages',async()=>{
  const f=queue();let started=0;f.port.read=async()=>{f.controller.abort();return [msg('unscheduled')]};await consumeAgentStream(f.port,async()=>{started++;return 'ack'},{signal:f.controller.signal});assert.equal(started,0);assert.deepEqual(f.acks,[])
})
test('consumer: bounded capacity starts only admitted messages, extra delivery stays pending',async()=>{
  const f=queue();let started=0,active=0,maximum=0
  f.port.read=async count=>{f.counts.push(count);return [msg('1'),msg('2'),msg('not-admitted')]}
  await consumeAgentStream(f.port,async()=>{started++;active++;maximum=Math.max(maximum,active);await new Promise<void>(resolve=>setTimeout(resolve,5));active--;if(started===2)f.controller.abort();return 'ack'},{signal:f.controller.signal,concurrency:2})
  assert.equal(maximum,2);assert.equal(started,2);assert.deepEqual(f.acks.sort(),['1','2']);assert.equal(f.counts[0],2)
})
test('consumer: reclaimed live heartbeat is retained and reclaim cursor advances',async()=>{
  const f=queue();let started=0;const cursors:string[]=[]
  f.port.reclaim=async cursor=>{cursors.push(cursor);return {cursor:'10-0',messages:[msg('live')]}}
  f.port.heartbeatExists=async()=>true;f.port.read=async()=>{f.controller.abort();return []}
  await consumeAgentStream(f.port,async()=>{started++;return 'ack'},{signal:f.controller.signal});assert.deepEqual(cursors,['0-0']);assert.equal(started,0);assert.deepEqual(f.acks,[])
})
test('consumer: wake validation rejects malformed commands without invoking runner',async()=>{
  let calls=0;const handler=createAgentWakeHandler({async runTurn(wake){calls++;assert.equal(wake.revision,'1')}})
  assert.equal(await handler({...fields,revision:'1e3'}),'retry');assert.equal(await handler({...fields,turnId:'other-owner'}),'retry');assert.equal(await handler(fields),'ack');assert.equal(calls,1)
})
test('consumer supervision: failure aborts sibling loop and awaits its delayed in-flight handler before returning failure',async()=>{
  const controller=new AbortController();let committed=false,closed=false,observedAbort=false
  const failing=async()=>{throw new Error('loop failed')}
  const sibling=async()=>{try{await new Promise<void>(resolve=>{const timer=setTimeout(resolve,30);controller.signal.addEventListener('abort',()=>{observedAbort=true;clearTimeout(timer);setTimeout(()=>{committed=true;resolve()},20)},{once:true})})}finally{closed=true}}
  await assert.rejects(superviseWorkerLoops([failing,sibling],controller),/loop failed/)
  assert.equal(controller.signal.aborted,true);assert.equal(observedAbort,true);assert.equal(committed,true);assert.equal(closed,true)
})
test('consumer supervision: successful external abort drains all loops before resolving',async()=>{
  const controller=new AbortController();let drained=false
  await superviseWorkerLoops([async()=>{await new Promise<void>(resolve=>setTimeout(resolve,5));controller.abort()},async()=>{await new Promise<void>(resolve=>setTimeout(resolve,20));drained=true}],controller)
  assert.equal(drained,true)
})
test('consumer: failed initial heartbeat cannot schedule or ACK work',async()=>{
  const f=queue();let calls=0;f.port.heartbeat=async()=>{throw new Error('redis down')};await consumeAgentStream(f.port,async()=>{calls++;return 'ack'},{signal:f.controller.signal,concurrency:1});assert.equal(calls,0);assert.deepEqual(f.acks,[])
})

test('agent boot supervision: failing media loop aborts turn runner and drains durable handler before shared teardown',async()=>{
  const shutdown=new AbortController();const order:string[]=[]
  let announceStarted!:()=>void
  const started=new Promise<void>(resolve=>{announceStarted=resolve})
  let turnSignal:AbortSignal|undefined
  let reads=0
  const turnQueue:AgentConsumerQueue={async initialize(){},async reclaim(){return {cursor:'0-0',messages:[]}},async read(){if(reads++===0)return [msg('turn')];return new Promise(resolve=>{if(turnSignal?.aborted)resolve([]);else turnSignal?.addEventListener('abort',()=>resolve([]),{once:true})})},async heartbeatExists(){return false},async heartbeat(){},async ack(){order.push('ack')},close(){order.push('turn-blocking-close')}}
  const mediaQueue:AgentConsumerQueue={...turnQueue,async reclaim(){await started;throw new Error('media-loop-failed')},close(){order.push('media-blocking-close')}}
  const running=startAgentWorkers({signal:shutdown.signal,queueFactory:kind=>kind==='turn'?turnQueue:mediaQueue,composition:{createRunner(signal){turnSignal=signal;return {async runTurn(){announceStarted();await new Promise<void>(resolve=>{signal.addEventListener('abort',()=>{order.push('abort');setTimeout(()=>{order.push('durable');resolve()},10)},{once:true})})}}},async mediaEvents(){return 'ack'}}}).finally(()=>{order.push('shared-redis-close');order.push('observability-close')})
  await assert.rejects(running,/media-loop-failed/)
  assert.ok(order.indexOf('abort')>=0);assert.ok(order.indexOf('durable')>order.indexOf('abort'));assert.ok(order.indexOf('ack')>order.indexOf('durable'));assert.ok(order.indexOf('shared-redis-close')>order.indexOf('ack'));assert.ok(order.indexOf('observability-close')>order.indexOf('shared-redis-close'))
})
