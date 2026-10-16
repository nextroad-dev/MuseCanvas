import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { CANVAS_AGENT_SETTINGS_DEFAULTS } from '@musecanvas/contracts'
import { db } from '@musecanvas/database'
import type { Actor } from '../../auth/security'
import { readCanvasAgentSettings, updateCanvasAgentSettings } from './canvas-agent-settings'

const modelId = randomUUID(), credentialId = randomUUID()
const actor: Actor = { id: randomUUID(), email: 'admin@example.test', role: 'admin', status: 'active', createdAt: new Date().toISOString() }
const rawSettings = () => ({ singleton: true, enabled: false, language_model_config_id: null, max_tool_calls_per_turn: 12, max_jobs_per_turn: 4, timeout_ms: 120000, max_auto_continuations: 3, updated_by: null, updated_at: new Date() })
function mockDatabase(options: { protocol?: string; version?: string; credentialEnabled?: boolean; noModel?: boolean; auditFails?: boolean } = {}) {
  const calls: { sql: string; args: unknown[] }[] = []; let released = false; let row: Record<string, any> = rawSettings()
  const client = { release: () => { released = true }, query: async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args })
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
    if (sql.startsWith('SELECT singleton')) return { rows: [{ singleton: true }] }
    if (sql.startsWith('SELECT * FROM canvas_agent_settings')) return { rows: [row] }
    if (sql.startsWith('SELECT * FROM model_configs')) return { rows: options.noModel ? [] : [{ id: modelId, model_kind: 'language', enabled: true, provider_credential_id: credentialId, language_protocol: options.protocol ?? 'openai_chat', plugin_id: 'openai-language', plugin_version: options.version ?? '1.0.0' }] }
    if (sql.startsWith('SELECT * FROM provider_credentials')) return { rows: [{ id: credentialId, enabled: options.credentialEnabled ?? true, api_key_encrypted: 'nonempty-ciphertext', schema_id: 'legacy-api-key-v1' }] }
    if (sql.startsWith('UPDATE canvas_agent_settings')) {
      row = { ...row, updated_by: args[0] }
      for (const match of sql.matchAll(/(enabled|language_model_config_id|max_tool_calls_per_turn|max_jobs_per_turn|timeout_ms|max_auto_continuations) = \$(\d+)/g)) row[match[1]!] = args[Number(match[2]) - 1]
      return { rows: [row] }
    }
    if (sql.startsWith('INSERT INTO audit_logs')) { if (options.auditFails) throw new Error('audit-write-failed private URL'); return { rows: [] } }
    throw new Error('Unexpected query')
  } }
  const mocked = mock.method(db(), 'connect', async () => client)
  return { calls, restore: () => mocked.mock.restore(), released: () => released }
}
 test('admin GET exact settings DTO defaults strips storage metadata', async () => {
  const f = mockDatabase()
  try {
    const response = await readCanvasAgentSettings(), data = (await response.json()).data
    assert.deepEqual({ ...data, updatedAt: undefined }, { ...CANVAS_AGENT_SETTINGS_DEFAULTS, updatedAt: undefined })
    assert.equal('singleton' in data, false); assert.equal('updatedBy' in data, false); assert.equal(f.released(), true)
  } finally { f.restore() }
})
 test('admin PATCH validates selected builtin language config and audits in same committed transaction', async () => {
  const f = mockDatabase()
  try {
    const response = await updateCanvasAgentSettings(actor, { enabled: true, languageModelConfigId: modelId, maxAutoContinuations: 2 })
    assert.equal(response.status, 200); const data = (await response.json()).data; assert.equal(data.enabled, true); assert.equal(data.languageModelConfigId, modelId)
    assert.ok(f.calls.some(call => call.sql.includes('FOR UPDATE')))
    const update = f.calls.findIndex(call => call.sql.startsWith('UPDATE canvas_agent_settings')), audit = f.calls.findIndex(call => call.sql.startsWith('INSERT INTO audit_logs')), commit = f.calls.findIndex(call => call.sql === 'COMMIT')
    assert.ok(update < audit && audit < commit); assert.equal(f.calls[audit]!.args[0], actor.id); assert.equal(f.calls[update]!.args[0], actor.id)
  } finally { f.restore() }
})
 test('admin settings reject wrong protocol/version/credential/deleted model before write', async () => {
  for (const options of [{ protocol: 'openai_responses' }, { version: '2.0.0' }, { credentialEnabled: false }, { noModel: true }]) {
    const f = mockDatabase(options)
    try { const response = await updateCanvasAgentSettings(actor, { languageModelConfigId: modelId, enabled: true }); assert.equal(response.status, 409); assert.equal(f.calls.some(call => call.sql.startsWith('UPDATE')), false); assert.ok(f.calls.some(call => call.sql === 'ROLLBACK')) } finally { f.restore() }
  }
})
 test('admin settings strict parser/authorization rejects invalid and empty patches without transaction', async () => {
  const f = mockDatabase()
  try {
    for (const input of [{}, { timeoutMs: 999 }, { maxToolCallsPerTurn: 33 }, { maxJobsPerTurn: 9 }, { maxAutoContinuations: 11 }, { enabled: 'yes' }, { role: 'admin' }]) assert.equal((await updateCanvasAgentSettings(actor, input)).status, 400)
    assert.equal((await updateCanvasAgentSettings({ ...actor, role: 'user' }, { enabled: false })).status, 403)
    assert.equal(f.calls.length, 0)
  } finally { f.restore() }
})
 test('enabling without model fails; audit failure rolls back and sanitizes error', async () => {
  let f = mockDatabase()
  try { assert.equal((await updateCanvasAgentSettings(actor, { enabled: true })).status, 409); assert.ok(f.calls.some(call => call.sql === 'ROLLBACK')) } finally { f.restore() }
  f = mockDatabase({ auditFails: true })
  try { const response = await updateCanvasAgentSettings(actor, { enabled: false }); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('private URL')); assert.ok(f.calls.some(call => call.sql === 'ROLLBACK')); assert.equal(f.calls.some(call => call.sql === 'COMMIT'), false) } finally { f.restore() }
})
