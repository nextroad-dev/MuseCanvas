import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJsonDigest } from '@musecanvas/database'
import type { AgentTool, AgentToolContext } from '../ports'
import { createAgentToolExecutor } from './executor'

function fixture() {
  let effects=0
  const args={modelRevisionId:'media-rev',pricingRevision:'price-rev',prompt:'prepared',inputChecksum:'sha256'}
  const sql={async query(){return {rows:[],rowCount:0}}}
  const tool:AgentTool={name:'generate_image',schemaVersion:1,description:'Prepared media',parameters:{type:'object'},permissions:['media.write'],execution:'media_async',approval:'required',budget:{maxMediaJobs:1,maxMediaOutputs:1,maxEstimatedCost:null},async execute(context,input){assert.equal(context.sql,sql);assert.deepEqual(input,args);effects++;return {kind:'pending',jobIds:['durable-job']}}}
  const context={sql,scope:{ownerId:'owner',sessionId:'session',turnId:'turn'},toolCallId:'canonical-proposal',round:{roundId:'round',position:1,inputRevision:'1'},turn:{id:'turn'},budget:{async reserve(){throw new Error('unused')}},signal:new AbortController().signal} as unknown as AgentToolContext
  const registry={get:(name:string,version:number)=>name===tool.name&&version===1?tool:null,list:()=>[tool]}
  return {args,tool,context,registry,get effects(){return effects}}
}
test('executor: approved canonical proposal succeeds only through same SQL durable binding gate before and after effects',async()=>{
  const f=fixture();const hash=canonicalJsonDigest(f.args);let checks=0
  const execute=createAgentToolExecutor(f.registry,{mode:'enforce' as const,validateArguments:()=>true,async assertEffectAllowed(context,tool,args){assert.equal(context.sql,f.context.sql);assert.equal(context.toolCallId,'canonical-proposal');assert.equal(tool,f.tool);assert.equal(canonicalJsonDigest(args),hash);assert.equal(args.modelRevisionId,'media-rev');assert.equal(args.pricingRevision,'price-rev');checks++}})
  assert.deepEqual(await execute(f.context,'generate_image',1,f.args),{kind:'pending',jobIds:['durable-job']});assert.equal(checks,2);assert.equal(f.effects,1)
})
test('executor: missing approval gate yields fixed APPROVAL_REQUIRED and zero effects',async()=>{
  const f=fixture();const execute=createAgentToolExecutor(f.registry,{mode:'propose-only' as const,validateArguments:()=>true});const result=await execute(f.context,'generate_image',1,f.args);assert.equal(result.kind,'failed');if(result.kind==='failed')assert.equal(result.error.message,'APPROVAL_REQUIRED');assert.equal(f.effects,0)
})
test('executor: schema rejection and unknown versions fail closed before authorization or effects',async()=>{
  const f=fixture();let checks=0;const execute=createAgentToolExecutor(f.registry,{mode:'enforce' as const,validateArguments:()=>false,async assertEffectAllowed(){checks++}})
  assert.equal((await execute(f.context,'generate_image',1,f.args)).kind,'failed');assert.equal((await execute(f.context,'generate_image',2,f.args)).kind,'failed');assert.equal(checks,0);assert.equal(f.effects,0)
})
test('executor: invalid durable approval binding propagates for caller rollback before effects',async()=>{
  const f=fixture();const execute=createAgentToolExecutor(f.registry,{mode:'enforce' as const,validateArguments:()=>true,async assertEffectAllowed(){throw new Error('BINDING_DENIED')}});await assert.rejects(execute(f.context,'generate_image',1,f.args),/BINDING_DENIED/);assert.equal(f.effects,0)
})
test('executor: post-effect authorization loss propagates so caller can roll back all writes',async()=>{
  const f=fixture();let checks=0;const execute=createAgentToolExecutor(f.registry,{mode:'enforce' as const,validateArguments:()=>true,async assertEffectAllowed(){if(++checks===2)throw new Error('BINDING_CHANGED')}});await assert.rejects(execute(f.context,'generate_image',1,f.args),/BINDING_CHANGED/);assert.equal(f.effects,1);assert.equal(checks,2)
})
