import type { AgentCoreClient, AgentExecutionRepository } from '@musecanvas/database'
import type { AgentToolSettlementPort } from './ports'

/** Adapter only: caller owns transaction, commit and Redis ACK. */
export function createAgentToolSettlement(execution: Pick<AgentExecutionRepository,'recordToolResult'|'queueIfDependenciesTerminal'>): AgentToolSettlementPort {
  return {
    recordToolResult: (sql,input) => execution.recordToolResult(sql as AgentCoreClient,input),
    queueIfDependenciesTerminal: (sql,scope) => execution.queueIfDependenciesTerminal(sql as AgentCoreClient,scope),
  }
}
