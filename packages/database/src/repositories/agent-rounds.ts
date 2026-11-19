import type { AgentDecimal, AgentModelRoundStatus, AgentToolCallStatus, JsonObject } from '@musecanvas/contracts'
import type { AgentCoreClient } from './agent-core'
import { canonicalJsonDigest } from '../canonical-json-digest'
import type { AgentTurnScope } from './agent-runtime'

export interface AgentRoundCheckpoint {
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: JsonObject }>
  contentBlocks?: JsonObject[]
}
export interface AgentModelRoundRef { readonly roundId: string; readonly position: number; readonly inputRevision: AgentDecimal }

export interface AgentRoundRepository {
  beginModelRound(client: AgentCoreClient, input: { scope: AgentTurnScope; position: number; requestDigest: string; inputRevision: AgentDecimal; modelReferenceId: string }): Promise<AgentModelRoundRef>
  completeModelRound(client: AgentCoreClient, input: { scope: AgentTurnScope; roundId: string; status: Extract<AgentModelRoundStatus, 'completed' | 'failed' | 'superseded'>; usage: JsonObject | null; checkpoint: JsonObject | null }): Promise<void>
  recordToolCalls(client: AgentCoreClient, input: { scope: AgentTurnScope; roundId: string; calls: Array<{ providerCallId: string; toolName: string; toolSchemaVersion: number; arguments: JsonObject; argumentsHash: string; idempotencyKey: string }> }): Promise<Array<{ toolCallId: string; position: number }>>
  markToolCallStatus(client: AgentCoreClient, input: { scope: AgentTurnScope; toolCallId: string; from: readonly AgentToolCallStatus[]; to: AgentToolCallStatus; result?: JsonObject | null; error?: JsonObject | null }): Promise<boolean>
}

export function agentRoundCheckpoint(value: unknown): AgentRoundCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ROUND_CHECKPOINT')
  const raw = value as Record<string, unknown>
  if (typeof raw.text !== 'string' || !Array.isArray(raw.toolCalls)) throw new Error('INVALID_ROUND_CHECKPOINT')
  const ids = new Set<string>()
  const toolCalls = raw.toolCalls.map(call => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) throw new Error('INVALID_ROUND_CHECKPOINT')
    const item = call as Record<string, unknown>
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}__v[1-9][0-9]{0,3}$/.test(item.name)
      || !item.arguments || typeof item.arguments !== 'object' || Array.isArray(item.arguments)) throw new Error('INVALID_ROUND_CHECKPOINT')
    ids.add(item.id)
    return { id: item.id, name: item.name, arguments: item.arguments as JsonObject }
  })
  if (raw.contentBlocks !== undefined && !Array.isArray(raw.contentBlocks)) throw new Error('INVALID_ROUND_CHECKPOINT')
  if (raw.contentBlocks !== undefined) {
    const blocks = raw.contentBlocks as Record<string,unknown>[]
    if (blocks.some(block=>!block || (block.type !== 'text' && block.type !== 'tool_call'))) throw new Error('INVALID_ROUND_CHECKPOINT')
    const text = blocks.filter(block=>block.type==='text').map(block=>block.text)
    const calls = blocks.filter(block=>block.type==='tool_call').map(block=>block.toolCall)
    if (text.some(value=>typeof value!=='string') || text.join('')!==raw.text || canonicalJsonDigest(calls as JsonObject[])!==canonicalJsonDigest(toolCalls)) throw new Error('INVALID_ROUND_CHECKPOINT')
  }
  if (toolCalls.length>32 || Buffer.byteLength(JSON.stringify(value))>1_000_000) throw new Error('INVALID_ROUND_CHECKPOINT')
  return { text: raw.text, toolCalls, ...(raw.contentBlocks ? { contentBlocks: raw.contentBlocks as JsonObject[] } : {}) }
}
function requireRow<T>(rows: T[]): T { if (!rows[0]) throw new Error('AGENT_ROUND_NOT_FOUND'); return rows[0] }
function scopeArgs(scope: AgentTurnScope) { return [scope.sessionId, scope.turnId] }

export function createAgentRoundRepository(): AgentRoundRepository {
  return {
    async beginModelRound(client, input) {
      if (!Number.isSafeInteger(input.position) || input.position < 1) throw new Error('INVALID_ROUND_POSITION')
      const row = requireRow(await client.query(`INSERT INTO agent_model_rounds(session_id,turn_id,position,request_digest,input_revision,status,model_reference_id) VALUES($1,$2,$3,$4,$5,'running',$6)  RETURNING id,position,input_revision::text`, [...scopeArgs(input.scope), input.position, input.requestDigest, input.inputRevision, input.modelReferenceId]).then(r => r.rows))
      return { roundId: row.id, position: row.position, inputRevision: row.input_revision as AgentDecimal }
    },
    async completeModelRound(client, input) {
      if (input.status === 'completed') agentRoundCheckpoint(input.checkpoint)
      const result = await client.query(`UPDATE agent_model_rounds SET status=$4,usage=$5::jsonb,checkpoint=$6::jsonb,completed_at=clock_timestamp() WHERE id=$3 AND session_id=$1 AND turn_id=$2 AND status IN ('running','recorded')`, [...scopeArgs(input.scope), input.roundId, input.status, input.usage ? JSON.stringify(input.usage) : null, input.checkpoint ? JSON.stringify(input.checkpoint) : null])
      if (result.rowCount !== 1) throw new Error('AGENT_ROUND_NOT_RUNNING')
    },
    async recordToolCalls(client, input) {
      const result: Array<{ toolCallId: string; position: number }> = []
      for (let index = 0; index < input.calls.length; index++) {
        const call = input.calls[index]
        const hash = call.argumentsHash
        const row = requireRow(await client.query(`INSERT INTO agent_tool_calls(session_id,turn_id,round_id,position,provider_call_id,tool_name,tool_schema_version,arguments,arguments_hash,status,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'recorded',$10) RETURNING id,position`, [...scopeArgs(input.scope), input.roundId, index, call.providerCallId, call.toolName, call.toolSchemaVersion, JSON.stringify(call.arguments), hash, call.idempotencyKey]).then(r => r.rows))
        result.push({ toolCallId: row.id, position: row.position })
      }
      return result
    },
    async markToolCallStatus(client, input) {
      const result = await client.query(`UPDATE agent_tool_calls SET status=$4,result=$5::jsonb,error=$6::jsonb,updated_at=clock_timestamp() WHERE id=$3 AND session_id=$1 AND turn_id=$2 AND status = ANY($7::text[])`, [...scopeArgs(input.scope), input.toolCallId, input.to, input.result ? JSON.stringify(input.result) : null, input.error ? JSON.stringify(input.error) : null, input.from])
      return result.rowCount === 1
    },
  }
}
