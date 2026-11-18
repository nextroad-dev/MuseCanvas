import type { AgentCoreClient } from './agent-core'

const ZERO_DECIMAL = /^[+-]?0(?:\.0+)?$/

/**
 * A frozen zero price is only known when the reservation pins both a pricing
 * revision and a currency; anything else is a genuinely unknown provider cost.
 */
function knownZeroPrice(reservation: { reserved_amount: unknown; currency: unknown; pricing_revision: unknown }): boolean {
  return typeof reservation.pricing_revision === 'string' && reservation.pricing_revision.length > 0
    && typeof reservation.currency === 'string' && reservation.currency.length > 0
    && ZERO_DECIMAL.test(String(reservation.reserved_amount))
}

/** Same-client media accounting, shared by events and recovery. Never projects results or commits. */
export async function settleLinkedAgentMediaReservations(c: AgentCoreClient, tool: {id:string;turn_id:string;session_id:string}): Promise<boolean> {
  const jobs=(await c.query<{media_job_id:string;status:string;output_count:string;remote_uncertain:boolean}>(`SELECT l.media_job_id,j.status,
    (SELECT COUNT(*)::text FROM generation_outputs o JOIN assets a ON a.id=o.asset_id
      WHERE o.job_id=j.id AND a.created_by=l.owner_id AND a.deleted_at IS NULL AND j.status='succeeded') AS output_count,
    EXISTS(SELECT 1 FROM provider_runs p WHERE p.job_id=j.id AND p.operation_state NOT IN ('succeeded','failed','canceled')) AS remote_uncertain
    FROM agent_tool_job_links l JOIN generation_jobs j ON j.id=l.media_job_id AND j.created_by=l.owner_id
    WHERE l.tool_call_id=$1 AND l.turn_id=$2 AND l.session_id=$3 ORDER BY l.position FOR SHARE OF j`,[tool.id,tool.turn_id,tool.session_id])).rows
  if (!jobs.length) return false
  if (jobs.some(job=>!['succeeded','failed','canceled'].includes(job.status))) throw new Error('AGENT_MEDIA_NOT_TERMINAL')
  const reservations=(await c.query(`SELECT * FROM agent_budget_reservations WHERE tool_call_id=$1 AND turn_id=$2 AND session_id=$3 AND status='reserved' ORDER BY id FOR UPDATE`,[tool.id,tool.turn_id,tool.session_id])).rows
  const outputCount=jobs.reduce((sum,job)=>sum+BigInt(job.output_count),0n)
  for (const reservation of reservations) {
    if (reservation.quota==='media_jobs' || reservation.quota==='media_outputs') {
      await c.query(`UPDATE agent_budget_reservations SET status='settled',settled_at=clock_timestamp() WHERE id=$1 AND tool_call_id=$2 AND turn_id=$3 AND session_id=$4 AND status='reserved'`,[reservation.id,tool.id,tool.turn_id,tool.session_id])
      await c.query(`INSERT INTO agent_usage_entries(session_id,turn_id,reservation_id,settlement_key,usage_kind,amount,details)
        VALUES($1,$2,$3,$4,'actual',$5,$6::jsonb) ON CONFLICT(turn_id,settlement_key) DO NOTHING`,[tool.session_id,tool.turn_id,reservation.id,reservation.quota==='media_jobs'?`media:jobs:${tool.id}`:`media:outputs:${tool.id}`,reservation.quota==='media_jobs'?String(jobs.length):String(outputCount),JSON.stringify({quota:reservation.quota})])
    } else if (reservation.quota==='concurrent_media_jobs' && !jobs.some(job=>job.remote_uncertain)) {
      await c.query(`UPDATE agent_budget_reservations SET status='released',settled_at=clock_timestamp() WHERE id=$1 AND tool_call_id=$2 AND turn_id=$3 AND session_id=$4 AND status='reserved'`,[reservation.id,tool.id,tool.turn_id,tool.session_id])
    } else if (reservation.quota==='estimated_cost' && knownZeroPrice(reservation)) {
      // A known zero price settles; only a nonzero or unpinned price stays unknown.
      await c.query(`UPDATE agent_budget_reservations SET status='settled',settled_at=clock_timestamp() WHERE id=$1 AND tool_call_id=$2 AND turn_id=$3 AND session_id=$4 AND status='reserved'`,[reservation.id,tool.id,tool.turn_id,tool.session_id])
      await c.query(`INSERT INTO agent_usage_entries(session_id,turn_id,reservation_id,settlement_key,usage_kind,amount,currency,details)
        VALUES($1,$2,$3,$4,'actual',$5,$6,$7::jsonb) ON CONFLICT(turn_id,settlement_key) DO NOTHING`,[tool.session_id,tool.turn_id,reservation.id,`media:cost:${reservation.id}`,'0',reservation.currency,JSON.stringify({quota:'estimated_cost',reason:'zero_price_revision',pricingRevision:reservation.pricing_revision})])
    } else if (reservation.quota==='estimated_cost') {
      await c.query(`UPDATE agent_budget_reservations SET status='unknown',settled_at=clock_timestamp() WHERE id=$1 AND tool_call_id=$2 AND turn_id=$3 AND session_id=$4 AND status='reserved'`,[reservation.id,tool.id,tool.turn_id,tool.session_id])
      await c.query(`INSERT INTO agent_usage_entries(session_id,turn_id,reservation_id,settlement_key,usage_kind,amount,currency,details)
        VALUES($1,$2,$3,$4,'unknown',$5,$6,$7::jsonb) ON CONFLICT(turn_id,settlement_key) DO NOTHING`,[tool.session_id,tool.turn_id,reservation.id,`media:cost:${reservation.id}`,String(reservation.reserved_amount),reservation.currency,JSON.stringify({quota:'estimated_cost',unknownCost:true,reason:'media_provider_cost_unknown',pricingRevision:reservation.pricing_revision})])
    }
  }
  return true
}
