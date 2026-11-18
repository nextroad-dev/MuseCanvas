import { mediaCompletionDependencies, terminalAgentMediaTool } from '@musecanvas/database'
import type { AgentMediaEventDependencies, AgentMediaEventHandler } from './ports'

const consumer = 'agent-media-completion-v1'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
class CompletionNotReady extends Error {}

/**
 * Boot supplies delivery/ACK. This handler returns ACK only after SQL commit;
 * result, reservation settlement, complete-round resume and wake belong to the
 * injected settlement port on this SAME client. It must reconcile media_jobs,
 * media_outputs, the approved estimated_cost reservation and concurrent_media_jobs
 * exactly once with the result/wake. A locally cancelled Job does not prove the
 * remote run or its cost is terminal: inspect ProviderRun truth and retain unknown
 * reservations for M5 reconciliation, never release unknown cost as unused.
 * Production projections belong there too: tool_result Item content/message,
 * full tool/Turn DTOs, entity_revision and owner-scoped event cursors. There is
 * no recovery loop here.
 */
export function createAgentMediaEventHandler(dependencies: AgentMediaEventDependencies): AgentMediaEventHandler {
  return async event => {
    if (!uuid.test(event.eventId) || !uuid.test(event.jobId)) return 'ack'
    try {
      await dependencies.transaction(async client => {
        const receipt = await client.query(`SELECT event_id FROM agent_consumed_events WHERE consumer_name=$1 AND event_id=$2`, [consumer, event.eventId])
        if (receipt.rows.length) return
        const tools = await mediaCompletionDependencies(client, event.eventId, event.jobId)
        const resumable = new Map<string, typeof tools[number]>()
        for (const tool of tools) {
          const terminal = await terminalAgentMediaTool(client, tool)
          if (terminal.kind === 'wait') throw new CompletionNotReady()
          if (terminal.kind !== 'final') continue
          const current = await mediaCompletionDependencies(client, event.eventId, event.jobId)
          if (!current.some(t => t.toolCallId === tool.toolCallId && t.turnId === tool.turnId && t.ownerId === tool.ownerId)) continue
          const recorded = await dependencies.settlement.recordToolResult(client, {
            toolCallId: tool.toolCallId, sessionId: tool.sessionId, turnId: tool.turnId,
            idempotencyKey: `media-result:${tool.toolCallId}`, status: terminal.status, result: terminal.result,
            error: terminal.status === 'completed' ? null : { code: 'TOOL_FAILED', message: terminal.status === 'failed' ? 'Media generation failed' : 'Media generation cancelled', retryable: false },
          })
          if (recorded.finalResult) resumable.set(tool.turnId, tool)
        }
        // The owner verifies every tool/approval in the round is terminal and
        // atomically completes that round + queues a unique wake, or returns null.
        for (const scope of resumable.values()) await dependencies.settlement.queueIfDependenciesTerminal(client, scope)
        await client.query(`INSERT INTO agent_consumed_events(consumer_name,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [consumer, event.eventId])
      })
      return 'ack'
    } catch {
      // Persistence/settlement failures roll back both the receipt and result.
      // Do not expose SQL/provider details to the stream or ACK a failed commit.
      return 'retry'
    }
  }
}
