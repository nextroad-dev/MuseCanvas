import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentDecimal } from '@musecanvas/contracts'
import type { AgentCoreClient, AgentCoreTransaction } from '@musecanvas/database'
import { createAgentRuntimeComposition, type AgentCompositionDependencies } from './agent-composition'
import type { AgentRunnerDependencies } from './agent/runner'
import type { AgentModelFactoryDependencies } from './agent/model'

const sid = '10000000-0000-4000-8000-000000000001'
const tids = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002']
const owner = '30000000-0000-4000-8000-000000000001'
const wake = (id: string) => ({ eventId: '40000000-0000-4000-8000-000000000001', sessionId: sid, turnId: id, revision: '1' as AgentDecimal })

function fixture(extra: Partial<AgentCompositionDependencies> = {}) {
  const models: AgentModelFactoryDependencies[] = []
  const runners: AgentRunnerDependencies[] = []
  const queries: string[] = []
  let inactive = false
  let allowlist = ['get_asset@v1']
  const client = {
    async query(text: string, args: unknown[]) {
      queries.push(text)
      assert.match(text, /u.status='active'.*u.deleted_at IS NULL/s)
      assert.match(text, /s.active_turn_id=t.id/)
      return { rows: inactive ? [] : [{ owner_id: owner, deadline_at: new Date('2099-01-01T00:00:00Z'), config_snapshot: { toolAllowlist: allowlist, instructions: `instructions:${args[1]}` } }], rowCount: 1 }
    },
  } as unknown as AgentCoreClient
  const read: AgentCoreTransaction = work => work(client)
  const composition = createAgentRuntimeComposition({
    transaction: read, read,
    contextTransaction: async () => { throw new Error('not used by fake runner') },
    modelQuery: async () => { throw new Error('not used by fake model') },
    mediaEvents: async () => 'retry',
    executorApproval: { mode: 'propose-only' },
    modelFactory(deps) { models.push(deps); return { async complete() { throw new Error('not used') } } },
    runnerFactory(deps) { runners.push(deps); return { async runTurn() {} } },
    ...extra,
  })
  return { composition, models, runners, queries, disable() { inactive = true }, allow(value: string[]) { allowlist = value } }
}

test('composition binds a fresh model scope and definition allowlist for each Turn', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const worker = f.composition.createRunner(signal)
  await worker.runTurn(wake(tids[0]!))
  f.allow(['list_models@v1'])
  await worker.runTurn(wake(tids[1]!))
  assert.equal(f.models.length, 2)
  assert.deepEqual(f.models.map(m => m.scope.turnId), tids)
  assert.ok(f.models.every(m => m.scope.ownerId === owner && m.control.request === signal))
  assert.notEqual(f.runners[0]!.model, f.runners[1]!.model)
  assert.deepEqual(f.runners.map(r => r.registry.list().map(t => t.name)), [['get_asset'], ['list_models']])
  await assert.rejects(f.models[0]!.loadCredential({ modelConfigId: 'model', providerId: 'provider' }), /AGENT_UNSCOPED_CREDENTIAL_FORBIDDEN/)
})

test('composition accepts approved waiting turns and forwards the media policy seam', async () => {
  const media = {
    canMaterialize: () => true, isCanonical: () => false,
    readApproval: async () => null, materialize: async () => ({ toolCallId: 'proposal' }),
    executeApproved: async () => ({ kind: 'completed' as const, result: {} }),
  }
  const f = fixture({ media })
  await f.composition.createRunner(new AbortController().signal).runTurn(wake(tids[0]!))
  assert.deepEqual(f.runners[0]!.media, media)
  assert.match(f.queries[0]!, /t\.status IN \('queued','running','waiting_tools','waiting_approval'\)/)
})

test('composition never creates a model for inactive or nonactive work', async () => {
  const f = fixture(); f.disable()
  await f.composition.createRunner(new AbortController().signal).runTurn(wake(tids[0]!))
  assert.equal(f.models.length, 0)
  assert.equal(f.runners.length, 0)
})

test('composition fails closed for unavailable definition tools before creating a model', async () => {
  const f = fixture(); f.allow(['uninstalled@v1'])
  await assert.rejects(f.composition.createRunner(new AbortController().signal).runTurn(wake(tids[0]!)))
  assert.equal(f.models.length, 0)
  assert.equal(f.runners.length, 0)
})
