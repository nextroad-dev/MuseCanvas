import type { JsonObject, ToolExecutionResult } from '@musecanvas/contracts'
import type { AgentTool, AgentToolContext, AgentToolRegistry } from '../ports'

export type AgentToolExecutor = (context: AgentToolContext, name: string, version: number, args: JsonObject) => Promise<ToolExecutionResult>

/** Registry/schema implementation is injected so runtime cannot skip validation. */
interface CommonGate {
  validateArguments(tool: AgentTool, args: JsonObject): boolean
}

/**
 * The approval seam is an explicit mode, not an optional callback. `propose-only`
 * is what makes a raw media call return APPROVAL_REQUIRED (the runner then
 * materializes a durable proposal); `enforce` checks a persisted approval before
 * and after effects. Making mode required means adding an approval gate can
 * never silently turn every raw media call into TOOL_FAILED.
 */
export type AgentToolExecutionGate =
  | (CommonGate & { readonly mode: 'propose-only' })
  | (CommonGate & {
    readonly mode: 'enforce'
    /** Durable approval binding checked using context.sql. Absence of a mode is a type error. */
    assertEffectAllowed: (context: AgentToolContext, tool: AgentTool, args: JsonObject) => Promise<void>
  })
const denied = (): ToolExecutionResult => ({kind:'failed',error:{code:'TOOL_FAILED',message:'Tool is unavailable or arguments are invalid',retryable:false}})
export function createAgentToolExecutor(registry: AgentToolRegistry, gate: AgentToolExecutionGate) {
  return async (context: AgentToolContext, name: string, version: number, args: JsonObject): Promise<ToolExecutionResult> => {
    const tool = registry.get(name,version)
    if (!tool || !gate.validateArguments(tool,args)) return denied()
    if (context.signal.aborted) throw new Error('AGENT_ABORTED')
    if (tool.approval === 'required') {
      if (gate.mode === 'propose-only') return {kind:'failed',error:{code:'TOOL_FAILED',message:'APPROVAL_REQUIRED',retryable:false}}
      await gate.assertEffectAllowed(context,tool,args)
    }
    const result = await tool.execute(context,args)
    if (context.signal.aborted) throw new Error('AGENT_ABORTED')
    if (tool.approval === 'required' && gate.mode === 'enforce') await gate.assertEffectAllowed(context,tool,args)
    return result
  }
}
