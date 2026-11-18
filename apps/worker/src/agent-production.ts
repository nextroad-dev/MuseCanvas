import {
  db, createAgentExecutionRepository, createAgentExecutionBudgetRepository, assertAgentMediaApproval,
  type AgentCoreClient, type AgentTurnScope,
} from '@musecanvas/database'
import type { AgentBudgetDTO, AgentDecimal } from '@musecanvas/contracts'
import { createAgentDatabasePorts, type AgentDatabasePool } from './agent-database'
import { createAgentRuntimeComposition } from './agent-composition'
import { createAgentMediaEventHandler } from './agent/media-events'
import { createAgentToolSettlement } from './agent/settlement'
import { createAgentMediaRuntime } from './agent/media-runtime'
import { createAgentMediaTools, type AgentMediaToolPorts } from './agent/tools/media'
import { resolveRuntimeSettings } from './shared/runtime'

/** Construct only after bootstrap/schema preflight. No services start here. */
export function createProductionAgentComposition(pool: AgentDatabasePool = db()) {
  const database = createAgentDatabasePorts(pool)
  const execution = createAgentExecutionRepository()
  const budget = createAgentExecutionBudgetRepository()
  const mediaPorts: AgentMediaToolPorts = {
    // The approved executor re-checks this binding before and after its effects;
    // raw calls never reach it because they have no durable approval.
    async assertEffectAllowed(context, binding) {
      await assertAgentMediaApproval(context.sql, context.scope, context.toolCallId, context.round.roundId, binding.argumentsHash)
    },
    runtimeLimits: () => resolveRuntimeSettings(),
  }
  const media = createAgentMediaRuntime({
    ports: mediaPorts,
    reserveEstimatedCost: (client: AgentCoreClient, input: {
      scope: AgentTurnScope; roundId: string; toolCallId: string; amount: string; currency: string
      pricingRevision: string; limit: AgentBudgetDTO; nowMs: number
    }) => budget.reserveBudget(client, {
      scope: input.scope, roundId: input.roundId, toolCallId: input.toolCallId,
      limit: input.limit, nowMs: input.nowMs,
      reserve: { quota: 'estimated_cost', amount: input.amount as AgentDecimal, currency: input.currency,
        pricingRevision: input.pricingRevision, idempotencyKey: `media-proposal:${input.toolCallId}:estimated_cost` },
    }),
  })
  const mediaEvents = createAgentMediaEventHandler({
    transaction: database.transaction,
    settlement: createAgentToolSettlement(execution),
  })
  return createAgentRuntimeComposition({
    transaction: database.core,
    read: database.read,
    contextTransaction: database.readTransaction,
    modelQuery: database.modelQuery,
    mediaEvents,
    media,
    additionalTools: createAgentMediaTools(mediaPorts),
  })
}
