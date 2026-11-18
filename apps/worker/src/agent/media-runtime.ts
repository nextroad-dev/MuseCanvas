import { readAgentToolApproval, type AgentCoreClient, type AgentTurnScope } from '@musecanvas/database'
import type { AgentBudgetDTO } from '@musecanvas/contracts'
import type { AgentMediaProposalRunnerPort } from './runner'
import { isCanonicalMediaProposal, materializeAgentMediaProposal } from './media-proposal'
import { executeApprovedAgentMediaProposal, type AgentMediaToolPorts } from './tools/media'

/** The only names the media materializer may own; raw schema v1 is frozen. */
const MEDIA_TOOLS = new Set(['generate_image', 'generate_video', 'edit_image'])

/**
 * Media policy for the Runner. Raw calls stay immutable and fail closed as
 * `APPROVAL_REQUIRED`; only a materialized canonical proposal can be executed,
 * and only after its durable approval is checked again inside the executor.
 */
export function createAgentMediaRuntime(dependencies: {
  ports: AgentMediaToolPorts
  reserveEstimatedCost(client: AgentCoreClient, input: {
    scope: AgentTurnScope; roundId: string; toolCallId: string; amount: string; currency: string
    pricingRevision: string; limit: AgentBudgetDTO; nowMs: number
  }): Promise<{ id: string }>
}): AgentMediaProposalRunnerPort {
  return {
    canMaterialize(toolName, toolSchemaVersion) { return toolSchemaVersion === 1 && MEDIA_TOOLS.has(toolName) },
    isCanonical: isCanonicalMediaProposal,
    readApproval(client, scope, toolCallId) { return readAgentToolApproval(client, { scope, toolCallId }) },
    materialize(client, context, input) {
      if (!MEDIA_TOOLS.has(input.toolName)) throw new Error('AGENT_MEDIA_TOOL_UNAVAILABLE')
      return materializeAgentMediaProposal(client, context, {
        ...input,
        toolName: input.toolName as 'generate_image' | 'generate_video' | 'edit_image',
      }, {
        runtimeLimits: toolContext => dependencies.ports.runtimeLimits(toolContext),
        reserveEstimatedCost: dependencies.reserveEstimatedCost,
      })
    },
    executeApproved(context, toolName, toolSchemaVersion, args) {
      if (toolSchemaVersion !== 1 || !MEDIA_TOOLS.has(toolName)) throw new Error('AGENT_MEDIA_TOOL_UNAVAILABLE')
      return executeApprovedAgentMediaProposal(toolName as 'generate_image' | 'generate_video' | 'edit_image', context, args, dependencies.ports)
    },
  }
}
