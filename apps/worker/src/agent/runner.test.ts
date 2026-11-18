import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentBudgetDTO, AgentDecimal, AgentToolCallDTO, AgentTurnDTO, JsonObject } from '@musecanvas/contracts'
import { AgentExecutionBudgetError, AgentRuntimeError, type AgentCoreClient, type AgentExecutionState } from '@musecanvas/database'
import { MediaServiceError } from '@musecanvas/media-service'
import type { AgentModelResult, AgentTool } from './ports'
import { createAgentRunner, type AgentMediaProposalRunnerPort, type AgentRunnerDependencies } from './runner'

const scope={ownerId:'10000000-0000-4000-8000-000000000001',sessionId:'20000000-0000-4000-8000-000000000001',turnId:'30000000-0000-4000-8000-000000000001'}
const wake={eventId:'40000000-0000-4000-8000-000000000001',sessionId:scope.sessionId,turnId:scope.turnId,revision:'1' as AgentDecimal}
const instant=Date.now()
const result=(calls: AgentModelResult['toolCalls']=[]):AgentModelResult=>({text:calls.length?'Looking up':'Done',toolCalls:calls,contentBlocks:[],usage:{inputTokens:1,outputTokens:1}})
const tool:AgentTool={name:'get_asset',schemaVersion:1,description:'Read',parameters:{type:'object'},permissions:[],execution:'sync',approval:'never',budget:{maxMediaJobs:0,maxMediaOutputs:0,maxEstimatedCost:null},async execute(){return {kind:'completed',result:{id:'asset'}}}}
interface FakeApproval {
  id:string
  toolCallId:string
  status:'pending'|'approved'|'rejected'|'expired'
  expired:boolean
}
interface Memory {
  turn:AgentTurnDTO
  config:JsonObject
  budget:AgentBudgetDTO
  rounds:Array<{id:string;position:number;status:string;checkpoint:JsonObject|null}>
  tools:AgentToolCallDTO[]
  reservations:Array<{id:string;quota:string;amount:AgentDecimal;status:string}>
  items:Array<{type:string;toolCallId?:string;payload:unknown}>
  approvals:FakeApproval[]
  effects:number
}
function fixture(extra:Partial<AgentRunnerDependencies>={}) {
  let state:Memory={turn:{id:scope.turnId,sessionId:scope.sessionId,status:'queued',engineVersion:'agent-core-v1',revision:'1',inputRevision:'1',cancelRequestedAt:null,terminalAt:null,deadlineAt:new Date(instant+60_000).toISOString(),error:null},
    config:{protocol:'openai_chat',modelConfigId:'model',modelRevisionId:'revision',modelRevision:'1',providerId:'provider',pluginId:'openai-language',pluginVersion:'1.0.0',vendorModelId:'model-v1',maxOutputTokens:10,instructions:'test',toolAllowlist:['get_asset@v1']},
    budget:{maxModelCalls:10,maxToolCalls:10,maxMediaJobs:10,maxMediaOutputs:10,maxInputTokens:'100000',maxOutputTokens:'100000',maxEstimatedCost:null,maxConcurrentMediaJobs:10,deadlineAt:new Date(instant+60_000).toISOString()},rounds:[],tools:[],reservations:[],items:[],approvals:[],effects:0}
  let locked=false,modelCalls=0,commits=0,rollbacks=0,released=0,roundInputRevision='1'
  // Fence identity per guarded transaction proves two statements committed together.
  const audit={expires:0,fences:0,current:0,expireFence:-1,failureFence:-1}
  let response:()=>Promise<AgentModelResult>=async()=>result()
  let afterCheckpoint=false,loseRenewal=false,stopBeforeEffects=false
  const calls:string[]=[]
  const client={async query(raw:string,values:unknown[]=[]) {
    const text=raw.replace(/\s+/g,' ')
    if(text.includes('SELECT s.owner_id'))return {rows:[{owner_id:scope.ownerId}],rowCount:1}
    if(text.includes('SELECT position,input_revision'))return {rows:[{position:1,input_revision:roundInputRevision}],rowCount:1}
    if(text.includes('SELECT r.id,b.id'))return {rows:state.rounds.filter(row=>row.status==='running').flatMap(round=>state.reservations.filter(r=>r.status==='reserved').map(r=>({id:round.id,reservation_id:r.id,quota:r.quota,amount:r.amount,currency:null}))),rowCount:1}
    if(text.includes('SELECT media_job_id'))return {rows:[{media_job_id:'job'}],rowCount:1}
    if(text.includes('SELECT revision::text'))return {rows:[{revision:state.turn.revision}],rowCount:1}
    if(text.includes('agent_approvals')){
      assert.ok(locked,'approval expiry runs on the caller fenced transaction')
      if(!text.startsWith('UPDATE agent_approvals'))throw new Error(`Unexpected SQL ${text} ${values.length}`)
      audit.expires++;audit.expireFence=audit.current
      const row=state.approvals.find(approval=>values.includes(approval.id))
      if(!row||row.status!=='pending'||!row.expired)return {rows:[],rowCount:0}
      row.status='expired'
      return {rows:[{id:row.id}],rowCount:1}
    }
    if(text.includes('INSERT INTO agent_usage_entries')){assert.ok(locked);return {rows:[],rowCount:1}}
    throw new Error(`Unexpected SQL ${text} ${values.length}`)
  }} as unknown as AgentCoreClient
  const guarded=async<T>(fence:{expectedInputRevision:AgentDecimal},work:(client:AgentCoreClient)=>Promise<T>)=>{
    if(state.turn.cancelRequestedAt || state.turn.inputRevision!==fence.expectedInputRevision)throw new AgentRuntimeError('LEASE_REJECTED')
    const before=structuredClone(state)
    audit.current=++audit.fences
    locked=true
    try {const value=await work(client);if(state.turn.cancelRequestedAt || state.turn.inputRevision!==fence.expectedInputRevision)throw new AgentRuntimeError('LEASE_REJECTED');commits++;calls.push('commit');return value}
    catch(error){state=before;rollbacks++;throw error}
    finally{locked=false}
  }
  const dependencies:AgentRunnerDependencies={now:()=>instant,leaseDurationMs:1000,read:async work=>work(client),
    runtime:{async claimTurnLease(){if(['completed','failed'].includes(state.turn.status))return null;state.turn.status='running';return {...scope,leaseOwner:'worker',fencingToken:'1',inputRevision:state.turn.inputRevision,revision:'1',leaseUntil:new Date(instant+1000).toISOString()}},
      async renewTurnLease(){return loseRenewal?null:{...scope,leaseOwner:'worker',fencingToken:'1',inputRevision:state.turn.inputRevision,revision:'1',leaseUntil:new Date(instant+1000).toISOString()}},
      async releaseTurnLease(){released++;return true},withTurnLease:guarded,
      async transitionWithTurnLease(fence,transition,work){return guarded(fence,async c=>{const value=await work(c);if(state.reservations.some(r=>['reserved','unknown'].includes(r.status)) && ['completed','failed'].includes(transition.to))throw new AgentRuntimeError('TRANSITION_REJECTED');if(state.approvals.some(a=>a.status==='pending') && transition.to!=='waiting_approval')throw new AgentRuntimeError('TRANSITION_REJECTED');state.turn.status=transition.to;state.turn.error=transition.error as unknown as AgentTurnDTO['error'];calls.push(transition.to);return {work:value,turn:state.turn}})}},
    rounds:{async beginModelRound(_client,input){const round={id:`round-${input.position}`,position:input.position,status:'running',checkpoint:null};state.rounds.push(round);return {roundId:round.id,position:input.position,inputRevision:input.inputRevision}},
      async completeModelRound(_client,input){const round=state.rounds.find(r=>r.id===input.roundId)!;round.status=input.status;round.checkpoint=input.checkpoint},
      async recordToolCalls(_client,input){return input.calls.map((call,position)=>{const row:AgentToolCallDTO={id:`tool-${input.roundId}-${position}`,...scope,roundId:input.roundId,position,providerCallId:call.providerCallId,toolName:call.toolName,toolSchemaVersion:call.toolSchemaVersion,arguments:call.arguments,argumentsHash:call.argumentsHash,status:'recorded',result:null,error:null};state.tools.push(row);return {toolCallId:row.id,position}})},
      async markToolCallStatus(_client,input){const row=state.tools.find(t=>t.id===input.toolCallId)!;if(!input.from.includes(row.status))return false;row.status=input.to;return true}},
    budget:{async reserveBudget(_client,input){assert.ok(locked);if(state.reservations.some(r=>r.status==='unknown'))throw new AgentExecutionBudgetError('BUDGET_EXCEEDED');const quota=input.reserve.quota;const maximum=quota==='model_calls'?input.limit.maxModelCalls:quota==='tool_calls'?input.limit.maxToolCalls:quota==='input_tokens'?input.limit.maxInputTokens:quota==='output_tokens'?input.limit.maxOutputTokens:100000;const used=state.reservations.filter(r=>r.quota===quota && r.status!=='released').reduce((sum,r)=>sum+BigInt(r.amount),0n);if(used+BigInt(input.reserve.amount)>BigInt(maximum))throw new AgentExecutionBudgetError('BUDGET_EXCEEDED');const reservation={id:`budget-${state.reservations.length}`,quota:input.reserve.quota,amount:input.reserve.amount,status:'reserved'};state.reservations.push(reservation);return {...reservation,quota:input.reserve.quota,currency:null,pricingRevision:null}},
      async settleBudget(_client,input){state.reservations.find(r=>r.id===input.reservationId)!.status=input.outcome},async readBudgetUsage(){throw new Error('unused')}},
    execution:{async loadExecutionState(){if(stopBeforeEffects && afterCheckpoint){stopBeforeEffects=false;throw new Error('CRASH_AFTER_CHECKPOINT')}const snapshot:AgentExecutionState={turn:structuredClone(state.turn),config:state.config,budget:state.budget,items:[],pendingToolCalls:structuredClone(state.tools.filter(t=>!['completed','failed','cancelled','skipped'].includes(t.status))),nextRoundPosition:state.rounds.length+1,runningRounds:state.rounds.filter(r=>r.status==='running').length};return snapshot},
      async appendAssistantItem(_client,input){state.items.push({type:'assistant',payload:input});afterCheckpoint=true;return {} as never},async appendToolCallItem(_client,input){state.items.push({type:'tool_call',toolCallId:input.toolCallId,payload:input});return {} as never},
      async recordToolResult(_client,input){const row=state.tools.find(t=>t.id===input.toolCallId)!;row.status=input.status;row.result=input.result;row.error=input.error;audit.failureFence=audit.current;state.items.push({type:'tool_result',toolCallId:input.toolCallId,payload:input});return {recorded:true,finalResult:true}},async queueIfDependenciesTerminal(){return null}},
    registry:{get(name,version){return name===tool.name&&version===1?tool:null},list(){return [tool]}},
    executor:async()=>{assert.ok(locked);assert.equal(state.items.filter(i=>i.type==='tool_call').length,state.tools.length,'full assistant batch is durable before any effects');assert.ok(commits>=2);state.effects++;calls.push('effect');return {kind:'completed',result:{ok:true}}},
    context:{async build(){assert.equal(locked,false);assert.equal(state.tools.filter(t=>!['completed','failed'].includes(t.status)).length,0,'no unpaired call may reach model');return {system:'built instructions',messages:[{role:'user',content:'Hello'}]}}},
    model:{async complete(input){assert.equal(locked,false,'paid call is outside SQL locks');assert.equal(input.config.modelRevisionId,'revision');assert.equal(input.instructions,'built instructions');modelCalls++;return response()}},...extra}
  return {dependencies,get state(){return state},get modelCalls(){return modelCalls},get effects(){return state.effects},get commits(){return commits},get rollbacks(){return rollbacks},get released(){return released},get audit(){return audit},calls,
    respond(fn:()=>Promise<AgentModelResult>){response=fn},crashBeforeEffects(){stopBeforeEffects=true},loseRenewal(){loseRenewal=true},setRoundInputRevision(value:string){roundInputRevision=value},run(){return createAgentRunner(dependencies).runTurn(wake)}}
}

test('runner: text completion checkpoints and settles before terminal transition, calls outside locks',async()=>{
  const f=fixture();await f.run();assert.equal(f.modelCalls,1);assert.equal(f.state.turn.status,'completed');assert.equal(f.state.rounds[0]!.status,'completed');assert.ok(f.state.reservations.every(r=>r.status==='settled'));assert.equal(f.released,1)
})
test('runner: commits complete two-call batch before effects and pairs results before next model round',async()=>{
  const f=fixture();f.respond(async()=>f.modelCalls===1?result([{id:'call1',name:'get_asset__v1',arguments:{}},{id:'call2',name:'get_asset__v1',arguments:{}}]):result());await f.run();assert.equal(f.modelCalls,2);assert.equal(f.effects,2);assert.equal(f.state.items.filter(i=>i.type==='tool_result').length,2);assert.equal(f.state.turn.status,'completed')
})
test('runner: replay after checkpoint crash executes recorded calls once without paying for previous round again',async()=>{
  const f=fixture();f.respond(async()=>f.modelCalls===1?result([{id:'call1',name:'get_asset__v1',arguments:{}}]):result());f.crashBeforeEffects();await assert.rejects(f.run(),/CRASH_AFTER_CHECKPOINT/);assert.equal(f.effects,0);assert.equal(f.modelCalls,1);await f.run();assert.equal(f.effects,1);assert.equal(f.modelCalls,2);assert.equal(f.state.turn.status,'completed')
})
test('runner: uncertain provider outcome is durable and never blindly retried',async()=>{
  const f=fixture();f.respond(async()=>{throw new Error('secret upstream credential')});await f.run();assert.equal(f.state.rounds[0]!.status,'failed');assert.ok(f.state.reservations.every(r=>r.status==='unknown'));await f.run();assert.equal(f.state.turn.status,'running');assert.equal(f.modelCalls,1);assert.equal(JSON.stringify(f.state).includes('secret upstream'),false)
})
test('runner: crash with running model intent marks unknown and performs zero provider calls',async()=>{
  const f=fixture();f.state.rounds.push({id:'round-1',position:1,status:'running',checkpoint:null});f.state.reservations.push({id:'reserve',quota:'model_calls',amount:'1',status:'reserved'});await f.run();assert.equal(f.modelCalls,0);assert.equal(f.state.reservations[0]!.status,'unknown');assert.equal(f.state.rounds[0]!.status,'failed')
})
test('runner: stale input revision cannot commit model response or execute a tool',async()=>{
  const f=fixture();f.respond(async()=>{f.state.turn.inputRevision='2';return result([{id:'call',name:'get_asset__v1',arguments:{}}])});await f.run();assert.equal(f.effects,0);assert.equal(f.state.items.length,0);assert.equal(f.state.rounds[0]!.status,'running')
})
test('runner: cancel intent fences late responses with no new effects',async()=>{
  const f=fixture();f.respond(async()=>{f.state.turn.cancelRequestedAt=new Date().toISOString();return result()});await f.run();assert.equal(f.state.items.length,0);assert.equal(f.state.turn.status,'running')
})
test('runner: unknown monetary price denies a finite ceiling before a paid model call',async()=>{
  const f=fixture();f.state.budget.maxEstimatedCost={currency:'USD',amount:'10',pricingReference:'price1'};await f.run();assert.equal(f.modelCalls,0);assert.equal(f.state.turn.status,'failed')
})
test('runner: required raw request records APPROVAL_REQUIRED metadata through injected gate without effects',async()=>{
  const f=fixture();Object.assign(f.dependencies,{executor:async()=>({kind:'failed',error:{code:'TOOL_FAILED',message:'APPROVAL_REQUIRED',retryable:false}})});f.respond(async()=>f.modelCalls===1?result([{id:'call',name:'get_asset__v1',arguments:{}}]):result());await f.run();assert.equal(f.effects,0);assert.deepEqual(f.state.tools[0]!.result,{reason:'APPROVAL_REQUIRED',proposalRequired:true});assert.equal(f.state.tools[0]!.status,'failed')
})
test('runner: pending media has durable links and atomically hands off after effects',async()=>{
  const f=fixture();Object.assign(f.dependencies,{executor:async()=>({kind:'pending',jobIds:['job']})});f.respond(async()=>result([{id:'call',name:'get_asset__v1',arguments:{}}]));await f.run();assert.equal(f.state.turn.status,'waiting_tools');assert.equal(f.state.tools[0]!.status,'waiting_external');assert.equal(f.modelCalls,1)
})

test('runner: zero model budget is a controlled terminal budget failure before any paid call',async()=>{
  const f=fixture();f.state.budget.maxModelCalls=0;await f.run();assert.equal(f.modelCalls,0);assert.equal(f.state.turn.status,'failed');assert.equal(f.state.turn.error?.code,'BUDGET_EXCEEDED');assert.equal(f.state.rounds.length,0)
})
test('runner: exhausted model budget after a completed tool round fails safely without repeated paid admission',async()=>{
  const f=fixture();f.state.budget.maxModelCalls=1;f.respond(async()=>result([{id:'call1',name:'get_asset__v1',arguments:{}}]));await f.run();assert.equal(f.modelCalls,1);assert.equal(f.effects,1);assert.equal(f.state.turn.status,'failed');assert.equal(f.state.turn.error?.code,'BUDGET_EXCEEDED');assert.equal(f.state.rounds[0]!.status,'completed');await f.run();assert.equal(f.modelCalls,1)
})
test('runner: tool budget rejection preserves known checkpoint, call order, model settlement and failed result pairs',async()=>{
  const f=fixture();f.state.budget.maxToolCalls=0;const calls=[{id:'call1',name:'get_asset__v1',arguments:{id:'a'}},{id:'call2',name:'get_asset__v1',arguments:{id:'b'}}];f.respond(async()=>result(calls));await f.run();assert.equal(f.modelCalls,1);assert.equal(f.effects,0);assert.equal(f.state.turn.status,'failed');assert.equal(f.state.turn.error?.code,'BUDGET_EXCEEDED');assert.deepEqual(f.state.rounds[0]!.checkpoint?.toolCalls,calls);assert.ok(f.state.reservations.every(row=>row.status==='settled'));assert.deepEqual(f.state.tools.map(row=>row.error?.code),['BUDGET_EXCEEDED','BUDGET_EXCEEDED']);assert.equal(f.state.items.filter(row=>row.type==='tool_result').length,2);await f.run();assert.equal(f.modelCalls,1)
})
test('runner: mixed offered and unknown tools preserve raw batch and pairs without unauthorized effects',async()=>{
  const f=fixture();const calls=[{id:'valid',name:'get_asset__v1',arguments:{id:'asset'}},{id:'invalid',name:'unknown_tool__v1',arguments:{raw:'preserved'}}];f.respond(async()=>f.modelCalls===1?result(calls):result());await f.run();assert.deepEqual(f.state.rounds[0]!.checkpoint?.toolCalls,calls);assert.deepEqual(f.state.tools.map(row=>row.providerCallId),['valid','invalid']);assert.equal(f.state.tools[0]!.status,'completed');assert.equal(f.state.tools[1]!.status,'failed');assert.equal(f.effects,1);assert.equal(f.state.items.filter(row=>row.type==='tool_result').length,2)
})

const mediaTool:AgentTool={name:'generate_image',schemaVersion:1,description:'Generate an image',parameters:{type:'object'},permissions:['media:create'],execution:'media_async',approval:'required',budget:{maxMediaJobs:1,maxMediaOutputs:32,maxEstimatedCost:null},async execute(){throw new Error('RAW_TOOL_EXECUTED')}}
const mediaToolRow=(id:string,status:AgentToolCallDTO['status'],args:JsonObject):AgentToolCallDTO=>({id,sessionId:scope.sessionId,turnId:scope.turnId,roundId:'round-1',position:0,providerCallId:`agent-proposal:${id}`,toolName:'generate_image',toolSchemaVersion:1,arguments:args,argumentsHash:'a'.repeat(64),status,result:null,error:null})
const mediaArgs:JsonObject={modelId:'m',modelRevisionId:'media-revision',prompt:'draw',parameters:{},inputs:[],inputBindings:[],pricing:{amount:'0',currency:'USD',pricingRevision:'free-v1'}}
/** Reads approvals from the fixture store; expiry runs through the real DB helper on the fixture client. */
const approvalSeam=(rows:()=>FakeApproval[],executed:{approved:number}):AgentMediaProposalRunnerPort=>({
  canMaterialize:(name,version)=>name==='generate_image'&&version===1,isCanonical:()=>true,
  async readApproval(_client,_scope,toolCallId){const row=rows().find(entry=>entry.toolCallId===toolCallId);return row?{id:row.id,status:row.status,expired:row.expired}:null},
  async materialize(){throw new Error('UNEXPECTED_MATERIALIZATION')},
  async executeApproved(){executed.approved++;throw new Error('UNEXPECTED_CANONICAL_EXECUTION')}})

test('runner: raw media call materializes a durable proposal and waits without any effect',async()=>{
  const materialized:string[]=[];let executeApproved=0
  const f=fixture({registry:{get:(name,version)=>name==='generate_image'&&version===1?mediaTool:null,list:()=>[mediaTool]},
    media:{canMaterialize:(name,version)=>name==='generate_image'&&version===1,isCanonical:()=>false,readApproval:async()=>({id:'approval-1',status:'pending',expired:false}),
      async materialize(_client,_context,input){materialized.push(input.rawToolCallId);f.state.tools.push(mediaToolRow('proposal','waiting_approval',{canonical:true}));return {toolCallId:'proposal'}},
      async executeApproved(){executeApproved++;throw new Error('UNEXPECTED_CANONICAL_EXECUTION')}}})
  f.state.config.toolAllowlist=['generate_image@v1']
  Object.assign(f.dependencies,{executor:async()=>({kind:'failed',error:{code:'TOOL_FAILED',message:'APPROVAL_REQUIRED',retryable:false}})})
  f.respond(async()=>result([{id:'call',name:'generate_image__v1',arguments:{modelId:'m',prompt:'draw',parameters:[],inputs:[]}}]))
  await f.run()
  assert.deepEqual(materialized,[f.state.tools[0]!.id])
  assert.equal(executeApproved,0)
  assert.equal(f.effects,0)
  assert.equal(f.modelCalls,1)
  assert.equal(f.state.turn.status,'waiting_approval')
  assert.equal(f.state.tools[0]!.status,'waiting_external')
  assert.equal(f.state.tools[0]!.result,null)
  assert.equal(f.state.items.filter(item=>item.type==='tool_result').length,0)
  assert.equal(f.state.tools[1]!.status,'waiting_approval')
})

test('runner: only an approved proposal executes through the media seam and hands off as waiting_external',async()=>{
  let approvedCalls=0
  const f=fixture({media:{canMaterialize:(name,version)=>name==='generate_image'&&version===1,isCanonical:()=>true,
    readApproval:async()=>({id:'approval-1',status:'approved',expired:false}),
    async materialize(){throw new Error('UNEXPECTED_MATERIALIZATION')},
    async executeApproved(context,name,version,args){assert.equal(name,'generate_image');assert.equal(version,1);assert.equal(args.modelRevisionId,'media-revision');approvedCalls++;assert.ok(context.sql);return {kind:'pending',jobIds:['job']}}}})
  f.state.tools.push(mediaToolRow('proposal','waiting_approval',{modelId:'m',modelRevisionId:'media-revision',prompt:'draw',parameters:{},inputs:[],inputBindings:[],pricing:{amount:'0',currency:'USD',pricingRevision:'free-v1'}}))
  await f.run()
  assert.equal(approvedCalls,1)
  assert.equal(f.modelCalls,0)
  assert.equal(f.state.tools[0]!.status,'waiting_external')
  assert.equal(f.state.turn.status,'waiting_tools')
})

test('runner: a rejected approval becomes a paired failure without expiry and never reaches the media seam',async()=>{
  const executed={approved:0}
  const f=fixture()
  Object.assign(f.dependencies,{media:approvalSeam(()=>f.state.approvals,executed)})
  f.state.tools.push(mediaToolRow('proposal','waiting_approval',mediaArgs))
  f.state.approvals.push({id:'approval-1',toolCallId:'proposal',status:'rejected',expired:false})
  await f.run()
  assert.equal(f.audit.expires,0)
  assert.equal(executed.approved,0)
  assert.equal(f.state.approvals[0]!.status,'rejected')
  assert.equal(f.state.tools[0]!.status,'failed')
  assert.equal(f.state.tools[0]!.error?.code,'APPROVAL_REJECTED')
  assert.equal(f.state.items.filter(item=>item.type==='tool_result').length,1)
  assert.equal(f.state.turn.status,'completed')
})

test('runner: materialization failure becomes a paired PROPOSAL_INVALID result without leaking the cause',async()=>{
  const f=fixture({registry:{get:(name,version)=>name==='generate_image'&&version===1?mediaTool:null,list:()=>[mediaTool]},
    media:{canMaterialize:(name,version)=>name==='generate_image'&&version===1,isCanonical:()=>false,readApproval:async()=>({id:'approval-1',status:'pending',expired:false}),
      async materialize(){f.state.tools.push(mediaToolRow('partial','recorded',{canonical:true}));throw new MediaServiceError('INVALID_INPUT','secret model 999 and SQL detail',400)},
      async executeApproved(){throw new Error('UNEXPECTED_CANONICAL_EXECUTION')}}})
  f.state.config.toolAllowlist=['generate_image@v1']
  Object.assign(f.dependencies,{executor:async()=>({kind:'failed',error:{code:'TOOL_FAILED',message:'APPROVAL_REQUIRED',retryable:false}})})
  f.respond(async()=>f.modelCalls===1?result([{id:'call',name:'generate_image__v1',arguments:{modelId:'m',prompt:'draw',parameters:[],inputs:[]}}]):result())
  await f.run()
  assert.equal(f.state.tools.length,1,'a failed materialization leaves no proposal row')
  assert.equal(f.state.tools[0]!.status,'failed')
  assert.deepEqual(f.state.tools[0]!.result,{reason:'PROPOSAL_INVALID'})
  assert.deepEqual(f.state.tools[0]!.error,{code:'TOOL_FAILED',message:'Media proposal could not be materialized',retryable:false})
  assert.equal(f.state.items.filter(item=>item.type==='tool_result').length,1)
  assert.equal(f.modelCalls,2)
  assert.equal(f.state.turn.status,'completed')
  assert.equal(JSON.stringify(f.state).includes('secret model 999'),false)
})

test('runner: an approved proposal with a stale round input revision becomes APPROVAL_CONFLICT without executing media',async()=>{
  let approved=0
  const f=fixture({media:{canMaterialize:(name,version)=>name==='generate_image'&&version===1,isCanonical:()=>true,
    readApproval:async()=>({id:'approval-1',status:'approved',expired:false}),
    async materialize(){throw new Error('UNEXPECTED_MATERIALIZATION')},
    async executeApproved(){approved++;throw new Error('UNEXPECTED_CANONICAL_EXECUTION')}}})
  f.state.tools.push(mediaToolRow('proposal','waiting_approval',{modelId:'m',modelRevisionId:'media-revision',prompt:'draw',parameters:{},inputs:[],inputBindings:[],pricing:{amount:'0',currency:'USD',pricingRevision:'free-v1'}}))
  f.setRoundInputRevision('0')
  await f.run()
  assert.equal(approved,0)
  assert.equal(f.state.tools[0]!.status,'failed')
  assert.equal(f.state.tools[0]!.result,null)
  assert.deepEqual(f.state.tools[0]!.error,{code:'APPROVAL_CONFLICT',message:'Approved proposal was superseded by a new input revision',retryable:false})
  assert.equal(f.state.turn.status,'completed')
})

test('runner: a pending approval inside its window stays waiting without expiry or failure',async()=>{
  const executed={approved:0}
  const f=fixture()
  Object.assign(f.dependencies,{media:approvalSeam(()=>f.state.approvals,executed)})
  f.state.tools.push(mediaToolRow('proposal','waiting_approval',mediaArgs))
  f.state.approvals.push({id:'approval-1',toolCallId:'proposal',status:'pending',expired:false})
  await f.run()
  assert.equal(f.audit.expires,0)
  assert.equal(executed.approved,0)
  assert.equal(f.modelCalls,0)
  assert.equal(f.state.approvals[0]!.status,'pending')
  assert.equal(f.state.tools[0]!.status,'waiting_approval')
  assert.equal(f.state.items.filter(item=>item.type==='tool_result').length,0)
  assert.equal(f.state.turn.status,'waiting_approval')
})

test('runner: an expired pending approval is expired with its paired failure in one fenced transaction',async()=>{
  const executed={approved:0}
  const f=fixture()
  Object.assign(f.dependencies,{media:approvalSeam(()=>f.state.approvals,executed)})
  f.state.tools.push(mediaToolRow('proposal','waiting_approval',mediaArgs))
  f.state.approvals.push({id:'approval-1',toolCallId:'proposal',status:'pending',expired:true})
  await f.run()
  assert.equal(f.audit.expires,1)
  assert.ok(f.audit.expireFence>0)
  assert.equal(f.audit.expireFence,f.audit.failureFence,'expiry and its paired failure share one transaction')
  assert.equal(f.state.approvals[0]!.status,'expired')
  assert.equal(executed.approved,0)
  assert.equal(f.state.tools[0]!.status,'failed')
  assert.deepEqual(f.state.tools[0]!.error,{code:'APPROVAL_EXPIRED',message:'Agent approval expired',retryable:false})
  assert.equal(f.state.items.filter(item=>item.type==='tool_result').length,1)
  assert.equal(f.rollbacks,0)
  assert.equal(f.state.turn.status,'completed')
})

test('runner: an approved-but-expired approval expires nothing new and never executes media',async()=>{
  const executed={approved:0}
  const f=fixture()
  Object.assign(f.dependencies,{media:approvalSeam(()=>f.state.approvals,executed)})
  f.state.tools.push(mediaToolRow('proposal','waiting_approval',mediaArgs))
  f.state.approvals.push({id:'approval-1',toolCallId:'proposal',status:'approved',expired:true})
  await f.run()
  assert.equal(f.audit.expires,1)
  assert.equal(f.audit.expireFence,f.audit.failureFence,'expiry and its paired failure share one transaction')
  assert.equal(f.state.approvals[0]!.status,'approved','the helper only touches pending rows')
  assert.equal(executed.approved,0)
  assert.equal(f.state.tools[0]!.status,'failed')
  assert.equal(f.state.tools[0]!.result,null)
  assert.deepEqual(f.state.tools[0]!.error,{code:'APPROVAL_EXPIRED',message:'Agent approval expired',retryable:false})
  assert.equal(f.state.items.filter(item=>item.type==='tool_result').length,1)
  assert.equal(f.state.turn.status,'completed')
})
