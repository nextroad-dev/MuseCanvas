import type { JsonObject, ToolExecutionResult } from '@musecanvas/contracts'
import type { AgentTool, AgentToolContext, AgentToolRegistry } from '../ports'

export type AgentToolExecutor = (context: AgentToolContext, name: string, version: number, args: JsonObject) => Promise<ToolExecutionResult>

export interface AgentToolExecutionGate {
  /** Durable approval binding checked using context.sql. M5 supplies policy; absence denies. */
  assertEffectAllowed?: (context: AgentToolContext, tool: AgentTool, args: JsonObject) => Promise<void>
  /** Registry/schema implementation is injected so runtime cannot skip validation. */
  validateArguments(tool: AgentTool, args: JsonObject): boolean
}
const denied = (): ToolExecutionResult => ({kind:'failed',error:{code:'TOOL_FAILED',message:'Tool is unavailable or arguments are invalid',retryable:false}})
export function createAgentToolExecutor(registry: AgentToolRegistry, gate: AgentToolExecutionGate) {
  return async (context: AgentToolContext, name: string, version: number, args: JsonObject): Promise<ToolExecutionResult> => {
    const tool = registry.get(name,version)
    if (!tool || !gate.validateArguments(tool,args)) return denied()
    if (context.signal.aborted) throw new Error('AGENT_ABORTED')
    if (tool.approval === 'required') {
      if (!gate.assertEffectAllowed) return {kind:'failed',error:{code:'TOOL_FAILED',message:'APPROVAL_REQUIRED',retryable:false}}
      await gate.assertEffectAllowed(context,tool,args)
    }
    const result = await tool.execute(context,args)
    if (context.signal.aborted) throw new Error('AGENT_ABORTED')
    if (tool.approval === 'required') await gate.assertEffectAllowed!(context,tool,args)
    return result
  }
}
