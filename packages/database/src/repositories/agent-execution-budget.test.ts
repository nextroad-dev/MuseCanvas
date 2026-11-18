import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentBudgetDTO, AgentDecimal } from '@musecanvas/contracts'
import type { AgentCoreClient } from './agent-core'
import { createAgentExecutionBudgetRepository, agentBudgetUnits, type AgentExecutionBudgetReserveInput } from './agent-execution-budget'
const scope={ownerId:'owner',sessionId:'session',turnId:'turn'}
const limit:AgentBudgetDTO={maxModelCalls:2,maxToolCalls:4,maxMediaJobs:2,maxMediaOutputs:4,maxInputTokens:'1000000000000000000',maxOutputTokens:'100',maxEstimatedCost:null,maxConcurrentMediaJobs:2,deadlineAt:'2099-01-01T00:00:00Z'}
interface Reservation {id:string;quota:string;amount:string;currency:string|null;pricing_revision:string|null;status:string;idempotency_key:string;round_id:string|null;tool_call_id:string|null;actual:string|null;usage_kind:string|null;unknown_usage?:boolean;details:Record<string,unknown>}
interface StandaloneUsage {quota:string;amount:string;currency:string|null;usage_kind:string;details:Record<string,unknown>}
function fixture() {
  const rows:Reservation[]=[];const standalone:StandaloneUsage[]=[];let live=true;const queries:string[]=[]
  const client={async query(raw:string,args:unknown[]=[]) {
    const sql=raw.replace(/\s+/g,' ').trim();queries.push(sql)
    const bindings=[...sql.matchAll(/\$(\d+)/g)].map(match=>Number(match[1]));assert.equal(Math.max(0,...bindings),args.length,'bind count')
    if(sql.startsWith('WITH usage AS'))return {rows:[...rows.map(row=>({...row,unknown_cost:row.usage_kind==='unknown'||row.details.unknownCost===true,unknown_usage:row.unknown_usage===true||row.usage_kind==='unknown'})),...standalone.map(row=>({id:null,quota:row.quota,amount:row.amount,currency:row.currency,pricing_revision:null,status:'settled',tool_call_id:null,round_id:null,actual:row.amount,usage_kind:row.usage_kind,unknown_cost:row.usage_kind==='unknown'||row.details.unknownCost===true,unknown_usage:row.usage_kind==='unknown'}))],rowCount:rows.length+standalone.length}
    if(sql.startsWith('SELECT *,reserved_amount')&&sql.includes('idempotency_key'))return {rows:rows.filter(row=>row.idempotency_key===args[2]),rowCount:1}
    if(sql.startsWith('SELECT clock_timestamp'))return {rows:[{live}],rowCount:1}
    if(sql.startsWith('SELECT b.id,b.quota'))return {rows:structuredClone(rows),rowCount:rows.length}
    if(sql.startsWith('INSERT INTO agent_budget_reservations')) {const row:Reservation={id:`reserve-${rows.length}`,quota:String(args[4]),amount:String(args[5]),currency:args[6] as string|null,pricing_revision:args[7] as string|null,status:'reserved',idempotency_key:String(args[8]),tool_call_id:args[2] as string|null,round_id:args[3] as string|null,actual:null,usage_kind:null,details:{}};rows.push(row);return {rows:[row],rowCount:1}}
    if(sql.startsWith('SELECT *,reserved_amount')&&sql.includes('FOR UPDATE'))return {rows:rows.filter(row=>row.id===args[2]),rowCount:1}
    if(sql.startsWith('UPDATE agent_budget_reservations')){rows.find(row=>row.id===args[2])!.status=String(args[3]);return {rows:[],rowCount:1}}
    if(sql.startsWith('INSERT INTO agent_usage_entries')){if(args[2]===null){standalone.push({quota:JSON.parse(String(args[7])).quota,amount:String(args[5]),currency:args[6] as string|null,usage_kind:String(args[4]),details:JSON.parse(String(args[7]))});return {rows:[],rowCount:1}}const row=rows.find(row=>row.id===args[2])!;row.actual=String(args[5]);row.usage_kind=String(args[4]);row.unknown_usage=String(args[4])==='unknown';row.details=JSON.parse(String(args[7]));return {rows:[],rowCount:1}}
    if(sql.startsWith('SELECT amount::text,currency')){const row=rows.find(row=>row.id===args[2])!;return {rows:[{amount:row.actual,currency:row.currency,usage_kind:row.usage_kind,details:row.details}],rowCount:1}}
    throw new Error(`Unexpected fixture query ${sql}`)
  }} as unknown as AgentCoreClient
  const repo=createAgentExecutionBudgetRepository()
  const reserve=(request:AgentExecutionBudgetReserveInput,budget=limit)=>repo.reserveBudget(client,{scope,reserve:request,limit:budget,nowMs:0,roundId:'round'})
  return {repo,client,rows,standalone,queries,reserve,expire(){live=false}}
}
test('execution budget: exact nano-unit parsing preserves large token and fractional monetary amounts',()=>{
  assert.equal(agentBudgetUnits('9007199254740993.123456789'),9007199254740993123456789n);assert.throws(()=>agentBudgetUnits('1.0000000001'));assert.throws(()=>agentBudgetUnits('-1'))
})
test('execution budget: settled usage still consumes admission; unknown reservations never become free',async()=>{
  const f=fixture();const first=await f.reserve({quota:'model_calls',amount:'1',idempotencyKey:'first'})
  await f.repo.settleBudget(f.client,{scope,reservationId:first.id,outcome:'settled',usage:{kind:'actual',amount:'1',currency:null,details:{}}})
  await f.reserve({quota:'model_calls',amount:'1',idempotencyKey:'second'});await assert.rejects(f.reserve({quota:'model_calls',amount:'1',idempotencyKey:'third'}),/BUDGET_EXCEEDED/)
  assert.equal((await f.repo.readBudgetUsage(f.client,scope)).modelCalls,2);assert.equal(f.rows[0]!.details.quota,'model_calls')
})
test('execution budget: idempotent reserve reuses identity and rejects changed scope binding or amount',async()=>{
  const f=fixture();const request={quota:'output_tokens' as const,amount:'10' as AgentDecimal,idempotencyKey:'same'};const first=await f.reserve(request);assert.equal((await f.reserve(request)).id,first.id);assert.equal(f.rows.length,1);await assert.rejects(f.reserve({...request,amount:'11'}),/BUDGET_CONFLICT/)
})
test('execution budget: DB-clock expiry rejects admission regardless of supplied application time',async()=>{
  const f=fixture();f.expire();await assert.rejects(f.reserve({quota:'model_calls',amount:'1',idempotencyKey:'expired'}),/BUDGET_EXCEEDED/);assert.equal(f.rows.length,0)
})
test('execution budget: unknown provider outcome retains reservation and blocks further paid admission',async()=>{
  const f=fixture();const first=await f.reserve({quota:'model_calls',amount:'1',idempotencyKey:'first'});await f.repo.settleBudget(f.client,{scope,reservationId:first.id,outcome:'unknown',usage:{kind:'unknown',amount:'1',currency:null,details:{reason:'transport_unknown'}}});await assert.rejects(f.reserve({quota:'model_calls',amount:'1',idempotencyKey:'next'}),/BUDGET_EXCEEDED/);assert.equal((await f.repo.readBudgetUsage(f.client,scope)).modelCalls,1)
})
test('execution budget: released concurrency returns capacity while cumulative settled usage remains',async()=>{
  const f=fixture();const first=await f.reserve({quota:'concurrent_media_jobs',amount:'2',idempotencyKey:'jobs'});await f.repo.settleBudget(f.client,{scope,reservationId:first.id,outcome:'released'});assert.equal((await f.repo.readBudgetUsage(f.client,scope)).concurrentMediaJobs,0);await f.reserve({quota:'concurrent_media_jobs',amount:'2',idempotencyKey:'new-jobs'})
})
test('execution budget: fractional cost ceiling and denomination fail closed without floating point rounding',async()=>{
  const f=fixture();const monetary={...limit,maxEstimatedCost:{currency:'USD',amount:'0.3',pricingReference:'p1'}};await f.reserve({quota:'estimated_cost',amount:'0.100000001' as AgentDecimal,currency:'USD',pricingRevision:'p1',idempotencyKey:'a'},monetary);await f.reserve({quota:'estimated_cost',amount:'0.199999999' as AgentDecimal,currency:'USD',pricingRevision:'p1',idempotencyKey:'b'},monetary);await assert.rejects(f.reserve({quota:'estimated_cost',amount:'0.000000001' as AgentDecimal,currency:'USD',pricingRevision:'p1',idempotencyKey:'c'},monetary),/BUDGET_EXCEEDED/);await assert.rejects(f.reserve({quota:'estimated_cost',amount:'0' as AgentDecimal,currency:'EUR',pricingRevision:'p1',idempotencyKey:'d'},monetary),/BUDGET_EXCEEDED/)
})
test('execution budget: unknown settlement cannot reduce its reserved upper bound, while actual usage may be lower',async()=>{
  const f=fixture();const unknown=await f.reserve({quota:'input_tokens',amount:'100',idempotencyKey:'unknown'});await f.repo.settleBudget(f.client,{scope,reservationId:unknown.id,outcome:'settled',usage:{kind:'unknown',amount:'0' as AgentDecimal,currency:null,details:{reason:'missing'}}});assert.equal((await f.repo.readBudgetUsage(f.client,scope)).inputTokens,100n)
  await assert.rejects(f.reserve({quota:'input_tokens',amount:'1',idempotencyKey:'no-room'}, {...limit,maxInputTokens:'100'}),/BUDGET_EXCEEDED/)
  const actual=await f.reserve({quota:'input_tokens',amount:'100',idempotencyKey:'actual'});await f.repo.settleBudget(f.client,{scope,reservationId:actual.id,outcome:'settled',usage:{kind:'actual',amount:'20' as AgentDecimal,currency:null,details:{}}});assert.equal((await f.repo.readBudgetUsage(f.client,scope)).inputTokens,120n)
})
test('execution budget: custom M5 settlement keys aggregate actual usage, including actual above reservation without double counting',async()=>{
  const f=fixture();const reservation=await f.reserve({quota:'media_jobs',amount:'10' as AgentDecimal,idempotencyKey:'m5-custom'}, {...limit,maxMediaJobs:20});f.rows[0]!.status='settled'
  await f.client.query(`INSERT INTO agent_usage_entries(session_id,turn_id,reservation_id,settlement_key,usage_kind,amount,currency,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[scope.sessionId,scope.turnId,reservation.id,'m5:custom:paid-usage','actual','20',null,JSON.stringify({quota:'media_jobs'})])
  assert.equal((await f.repo.readBudgetUsage(f.client,scope)).mediaJobs,20)
  assert.ok(f.queries.filter(query=>query.startsWith('WITH usage AS')).every(query=>!query.includes('settlement_key=')))
})
test('execution budget: unknown standalone cost prevents known partial cost aggregate alongside priced media usage',async()=>{
  const f=fixture();const priced=await f.reserve({quota:'estimated_cost',amount:'2' as AgentDecimal,currency:'USD',pricingRevision:'price-v1',idempotencyKey:'media-cost'});await f.repo.settleBudget(f.client,{scope,reservationId:priced.id,outcome:'settled',usage:{kind:'actual',amount:'2' as AgentDecimal,currency:'USD',details:{}}})
  f.standalone.push({quota:'estimated_cost',amount:'0',currency:null,usage_kind:'unknown',details:{quota:'estimated_cost',unknownCost:true}})
  assert.equal((await f.repo.readBudgetUsage(f.client,scope)).estimatedCost,null)
})
test('execution budget: duplicate settlement validates amount/kind/details and never inserts twice',async()=>{
  const f=fixture();const first=await f.reserve({quota:'model_calls',amount:'1',idempotencyKey:'first'});const settlement={scope,reservationId:first.id,outcome:'settled' as const,usage:{kind:'actual' as const,amount:'1' as AgentDecimal,currency:null,details:{source:'provider'}}};await f.repo.settleBudget(f.client,settlement);await f.repo.settleBudget(f.client,settlement);await assert.rejects(f.repo.settleBudget(f.client,{...settlement,usage:{...settlement.usage,amount:'2'}}),/BUDGET_CONFLICT/);assert.equal(f.queries.filter(query=>query.startsWith('INSERT INTO agent_usage_entries')).length,1)
})
test('execution budget: unknown monetary usage kind alone cannot produce a known price total',async()=>{
  const f=fixture();const priced=await f.reserve({quota:'estimated_cost',amount:'2' as AgentDecimal,currency:'USD',pricingRevision:'p1',idempotencyKey:'unknown-price'});await f.repo.settleBudget(f.client,{scope,reservationId:priced.id,outcome:'settled',usage:{kind:'unknown',amount:'0' as AgentDecimal,currency:'USD',details:{}}});assert.equal((await f.repo.readBudgetUsage(f.client,scope)).estimatedCost,null)
})
test('execution budget: standalone attributed actual usage participates in subsequent quota admission',async()=>{
  const f=fixture();f.standalone.push({quota:'model_calls',amount:'2',currency:null,usage_kind:'actual',details:{quota:'model_calls'}});assert.equal((await f.repo.readBudgetUsage(f.client,scope)).modelCalls,2);await assert.rejects(f.reserve({quota:'model_calls',amount:'1',idempotencyKey:'standalone-full'}),/BUDGET_EXCEEDED/)
})
