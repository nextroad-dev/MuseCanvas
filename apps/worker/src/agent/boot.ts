import type { AgentMediaEventHandler, AgentRunner } from './ports'
import { consumeAgentStream, createAgentMediaWakeHandler, createAgentWakeHandler, superviseWorkerLoops, type AgentConsumerQueue } from './consumer'
import { createAgentRedisQueue } from './redis-queue'

export interface AgentWorkerComposition {
  createRunner(signal: AbortSignal): AgentRunner
  readonly mediaEvents: AgentMediaEventHandler
}
export interface AgentWorkerBootOptions {
  readonly signal: AbortSignal
  readonly composition?: AgentWorkerComposition
  readonly concurrency?: number
  readonly onActivity?: () => void
  readonly queueFactory?: (kind:'turn'|'media')=>AgentConsumerQueue
}
/**
 * Lead integration seam. Lane factories compose here at the caller; this file
 * never imports model/context/registry/media implementations or M5 policy.
 * Uncomposed commands fail closed and remain in Redis pending for recovery.
 */
export async function startAgentWorkers(options: AgentWorkerBootOptions): Promise<void> {
  const factory=options.queueFactory ?? createAgentRedisQueue
  const supervisor=new AbortController()
  const forwardAbort=()=>supervisor.abort()
  options.signal.addEventListener('abort',forwardAbort,{once:true})
  if(options.signal.aborted)supervisor.abort()
  const unavailable=async ():Promise<'retry'>=>{throw new Error('AGENT_RUNTIME_NOT_COMPOSED')}
  const runner=options.composition?.createRunner(supervisor.signal)
  const turns=runner?createAgentWakeHandler(runner):unavailable
  const media=options.composition?createAgentMediaWakeHandler(options.composition.mediaEvents):unavailable
  if (!options.composition) console.error('agent runtime composition missing',{code:'AGENT_RUNTIME_NOT_COMPOSED'})
  const optionsForConsumer={signal:supervisor.signal,concurrency:options.concurrency,onActivity:options.onActivity,onError:(code:string)=>console.error('agent consumer operation failed',{code})}
  try {
    await superviseWorkerLoops([
      ()=>consumeAgentStream(factory('turn'),turns,optionsForConsumer),
      ()=>consumeAgentStream(factory('media'),media,optionsForConsumer),
    ],supervisor)
  } finally { options.signal.removeEventListener('abort',forwardAbort) }
}
