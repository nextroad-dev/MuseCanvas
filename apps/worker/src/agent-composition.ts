import {
  AgentRuntimeRepository, createAgentRoundRepository, createAgentExecutionRepository,
  createAgentExecutionBudgetRepository, type AgentCoreTransaction,
} from '@musecanvas/database'
import type { AgentWorkerComposition } from './agent/boot'
import { createAgentContext } from './agent/context'
import { createAgentModel, type AgentModelQuery } from './agent/model'
import { createAgentRunner, type AgentMediaProposalRunnerPort, type AgentRunnerDependencies } from './agent/runner'
import { createAgentToolExecutor } from './agent/tools/executor'
import { createReadonlyAgentTools } from './agent/tools/readonly'
import { createAgentToolRegistry } from './agent/tools/registry'
import type { JsonObject } from '@musecanvas/contracts'
import type { AgentMediaEventHandler, AgentTransaction, AgentTool, AgentToolContext } from './agent/ports'

export interface AgentCompositionDependencies {
  readonly transaction: AgentCoreTransaction
  readonly read: AgentCoreTransaction
  readonly contextTransaction: AgentTransaction
  readonly modelQuery: AgentModelQuery
  readonly mediaEvents: AgentMediaEventHandler
  readonly media?: AgentMediaProposalRunnerPort
  readonly additionalTools?: readonly AgentTool[]
  /**
   * Required: the executor must be told whether it is a proposal producer or an
   * approval enforcer. Leaving this implicit made one optional callback decide
   * whether every raw media call works or silently fails.
   */
  readonly executorApproval:
    | { readonly mode: 'propose-only' }
    | { readonly mode: 'enforce'; readonly assertEffectAllowed: (context: AgentToolContext, tool: AgentTool, args: JsonObject) => Promise<void> }
  /** Factories are injectable for composition tests; production uses real factories. */
  readonly runnerFactory?: typeof createAgentRunner
  readonly modelFactory?: typeof createAgentModel
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Scope and registry are rebuilt for every durable wake, never shared between Turns. */
export function createAgentRuntimeComposition(dependencies: AgentCompositionDependencies): AgentWorkerComposition {
  const runtime = new AgentRuntimeRepository(dependencies.transaction)
  const rounds = createAgentRoundRepository()
  const execution = createAgentExecutionRepository()
  const budget = createAgentExecutionBudgetRepository()
  const context = createAgentContext({ transaction: dependencies.contextTransaction })
  const tools = [...createReadonlyAgentTools(), ...(dependencies.additionalTools ?? [])]
  return {
    mediaEvents: dependencies.mediaEvents,
    createRunner(signal) {
      return {
        async runTurn(wake) {
          if (!uuid.test(wake.sessionId) || !uuid.test(wake.turnId)) throw new Error('AGENT_WAKE_INVALID')
          const row = (await dependencies.read(client => client.query<Record<string, unknown>>(`SELECT s.owner_id,t.deadline_at,t.config_snapshot
            FROM agent_sessions s JOIN agent_turns t ON t.session_id=s.id
            JOIN users u ON u.id=s.owner_id
            WHERE s.id=$1 AND t.id=$2 AND s.active_turn_id=t.id AND s.archived_at IS NULL
              AND u.status='active' AND u.deleted_at IS NULL AND t.engine_version='agent-core-v1'
              AND t.status IN ('queued','running','waiting_tools','waiting_approval') AND t.cancel_requested_at IS NULL AND clock_timestamp()<t.deadline_at`,
          [wake.sessionId, wake.turnId]))).rows[0]
          // Missing, canceled and terminal work is safely ACKable: M5 owns cleanup.
          if (!row) return
          const config = row.config_snapshot
          if (typeof row.owner_id !== 'string' || !uuid.test(row.owner_id)
            || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error('AGENT_CONFIG_UNAVAILABLE')
          const allowlist = (config as Record<string, unknown>).toolAllowlist
          if (!Array.isArray(allowlist) || !allowlist.every((item): item is string => typeof item === 'string')) {
            throw new Error('AGENT_CONFIG_UNAVAILABLE')
          }
          const deadline = row.deadline_at instanceof Date ? row.deadline_at.toISOString() : row.deadline_at
          if (typeof deadline !== 'string' || !Number.isFinite(Date.parse(deadline))) throw new Error('AGENT_CONFIG_UNAVAILABLE')
          const scope = { ownerId: row.owner_id, sessionId: wake.sessionId, turnId: wake.turnId }
          const registry = createAgentToolRegistry({ tools, allowlist })
          const validateArguments = (tool: AgentTool, args: JsonObject) => {
            try { registry.validate(tool.name, tool.schemaVersion, args); return true }
            catch { return false }
          }
          const executor = dependencies.executorApproval.mode === 'enforce'
            ? createAgentToolExecutor(registry, {
              mode: 'enforce',
              validateArguments,
              assertEffectAllowed: dependencies.executorApproval.assertEffectAllowed,
            })
            : createAgentToolExecutor(registry, { mode: 'propose-only', validateArguments })
          const model = (dependencies.modelFactory ?? createAgentModel)({
            query: dependencies.modelQuery, scope, control: { deadlineAt: deadline, request: signal },
            // The secure model factory never uses this weaker legacy seam.
            async loadCredential() { throw new Error('AGENT_UNSCOPED_CREDENTIAL_FORBIDDEN') },
          })
          const runner: AgentRunnerDependencies = {
            runtime, rounds, execution, budget, context, registry, executor, model, read: dependencies.read, signal,
            ...(dependencies.media ? { media: dependencies.media } : {}),
          }
          await (dependencies.runnerFactory ?? createAgentRunner)(runner).runTurn(wake)
        },
      }
    },
  }
}
