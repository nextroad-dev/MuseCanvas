import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { AGENT_BUDGET_QUOTAS } from '@musecanvas/contracts'
import { loadMigrations, normalizeStatement, splitStatements } from './loader'

const migrations = loadMigrations()
const core = migrations.find(migration => migration.name === 'agent_core')!
const ledgers = migrations.find(migration => migration.name === 'agent_ledgers_outbox_quarantine')!
const control = migrations.find(migration => migration.name === 'agent_control_plane')!
const recovery = migrations.find(migration => migration.name === 'agent_recovery_indexes')!

test('Agent migrations are additive, discoverable, transactional and have reverse scripts (source checks only)', () => {
  assert.equal(core.version, '0041')
  assert.equal(ledgers.version, '0042')
  assert.equal(control.version, '0043')
  for (const migration of [core, ledgers, control]) {
    assert.equal(migration.transactional, true)
    assert.ok(splitStatements(migration.sql).length > 10)
    assert.doesNotMatch(migration.sql, /INSERT INTO|DELETE FROM|DROP TABLE/i)
    const reverse = readFileSync(new URL(`../../rollback/${migration.filename}`, import.meta.url), 'utf8')
    assert.ok(reverse.includes('IF EXISTS'))
    let tablesChecked = 0; let indexesChecked = 0
    for (const rawStatement of splitStatements(migration.sql)) {
      const statement = normalizeStatement(rawStatement)
      if (/^CREATE TABLE/i.test(statement)) { tablesChecked++; assert.match(statement, /^CREATE TABLE IF NOT EXISTS/) }
      if (/^CREATE (UNIQUE )?INDEX/i.test(statement)) { indexesChecked++; assert.match(statement, /^CREATE (UNIQUE )?INDEX IF NOT EXISTS/) }
    }
    assert.equal(tablesChecked, migration === core ? 8 : migration === ledgers ? 5 : 2)
    assert.ok(indexesChecked > 0, `no indexes checked in ${migration.filename}`)
    if (migration !== control) assert.doesNotMatch(reverse, /ALTER TABLE agent_/)
  }
})

test('Agent source schema binds versions, owners, turns, round/tool identity and durable cursors', () => {
  assert.match(core.sql, /ON agent_definitions\(name, version\) WHERE owner_id IS NULL/)
  assert.match(core.sql, /FOREIGN KEY\(agent_definition_id, definition_version\) REFERENCES agent_definitions\(id, version\)/)
  assert.match(core.sql, /agent definition versions are immutable except retirement/)
  assert.match(core.sql, /FOREIGN KEY\(active_turn_id, id\) REFERENCES agent_turns\(id, session_id\)/)
  assert.match(core.sql, /ON agent_turns\(session_id\) WHERE status IN \('queued','running','waiting_tools','waiting_approval'\)/)
  assert.match(core.sql, /fencing_token bigint NOT NULL DEFAULT 0/)
  assert.match(core.sql, /NEW.fencing_token < OLD.fencing_token/)
  assert.match(core.sql, /new agent lease requires next fencing token/)
  assert.match(core.sql, /immutable agent turn snapshot/)
  assert.match(core.sql, /terminal agent turn cannot reopen/)
  assert.match(core.sql, /d.owner_id IS NULL OR d.owner_id=NEW.owner_id/)
  assert.match(core.sql, /next_item_sequence bigint NOT NULL DEFAULT 1/)
  assert.match(core.sql, /next_event_cursor bigint NOT NULL DEFAULT 1/)
  assert.match(core.sql, /UNIQUE\(session_id, cursor\)/)
  assert.match(core.sql, /UNIQUE\(session_id, sequence\)/)
  assert.match(core.sql, /UNIQUE\(turn_id, provider_call_id\)/)
  assert.match(core.sql, /UNIQUE\(turn_id, idempotency_key\)/)
  assert.match(core.sql, /UNIQUE\(round_id, position\)/)
  assert.match(core.sql, /FOREIGN KEY\(round_id, turn_id, session_id\) REFERENCES agent_model_rounds\(id, turn_id, session_id\)/)
  assert.match(core.sql, /ON agent_items\(tool_call_id\) WHERE item_type = 'tool_result'/)
  assert.match(core.sql, /agent tool result already final/)
  assert.match(ledgers.sql, /FOREIGN KEY\(media_job_id, owner_id\) REFERENCES generation_jobs\(id, created_by\)/)
  assert.match(ledgers.sql, /ON agent_tool_job_links\(media_job_id\)/)
  assert.doesNotMatch(ledgers.sql, /UNIQUE\(media_job_id\)/)
  assert.match(ledgers.sql, /FOREIGN KEY\(default_canvas_id, owner_id\) REFERENCES canvas_documents\(id, created_by\)/)
  assert.doesNotMatch(core.sql + ledgers.sql, /ON DELETE CASCADE/)
})

test('Agent schema includes durable dedupe, approval binding, accounting, engine pinning and quarantine', () => {
  assert.match(ledgers.sql, /PRIMARY KEY\(consumer_name, event_id\)/)
  assert.match(ledgers.sql, /UNIQUE\(turn_id, settlement_key\)/)
  assert.match(ledgers.sql, /reserved_amount numeric\(30,9\) NOT NULL CHECK\(reserved_amount >= 0\)/)
  assert.match(ledgers.sql, /usage_kind IN \('estimated','actual','unknown'\)/)
  assert.match(core.sql, /FOREIGN KEY\(tool_call_id, turn_id, session_id, arguments_hash\) REFERENCES agent_tool_calls/)
  assert.match(ledgers.sql, /FOREIGN KEY\(reservation_id, tool_call_id, turn_id, session_id, pricing_revision\)/)
  assert.match(ledgers.sql, /UNIQUE\(owner_id, client_request_key\)/)
  assert.match(ledgers.sql, /FOREIGN KEY\(legacy_turn_id, legacy_session_id\) REFERENCES canvas_agent_turns/)
  assert.match(ledgers.sql, /FOREIGN KEY\(agent_turn_id, agent_session_id\) REFERENCES agent_turns/)
  assert.match(ledgers.sql, /ADD COLUMN IF NOT EXISTS quarantined_at/)
  assert.match(ledgers.sql, /WHERE dispatched_at IS NULL AND quarantined_at IS NULL/)
})


test('Agent SQL reservation quota allowlist exactly matches public budget counters', () => {
  const quotaCheck = /quota IN \(([^)]+)\)/.exec(ledgers.sql)
  assert.ok(quotaCheck)
  const sqlQuotas = [...quotaCheck[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  assert.deepEqual(sqlQuotas, [...AGENT_BUDGET_QUOTAS])
  assert.match(ledgers.sql, /quota = 'estimated_cost' OR reserved_amount = trunc\(reserved_amount\)/)
})

test('M5 coordinator recovery indexes are additive, idempotent and reversible (source checks only)', () => {
  assert.equal(recovery.version, '0044')
  assert.equal(recovery.transactional, true)
  assert.doesNotMatch(recovery.sql, /CREATE TABLE|ALTER TABLE|INSERT INTO|DELETE FROM|DROP /i)
  const expected = [
    'agent_turns_deadline_recovery_idx',
    'agent_turns_cancel_recovery_idx',
    'agent_tool_calls_waiting_external_idx',
    'outbox_events_quarantine_idx',
  ]
  const statements = splitStatements(recovery.sql).map(normalizeStatement)
  assert.equal(statements.length, expected.length)
  for (const statement of statements) assert.match(statement, /^CREATE INDEX IF NOT EXISTS/)
  for (const name of expected) {
    assert.match(recovery.sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${name}\\b`))
    const reverse = readFileSync(new URL('../../rollback/0044_agent_recovery_indexes.sql', import.meta.url), 'utf8')
    assert.match(reverse, new RegExp(`DROP INDEX IF EXISTS ${name};`))
  }
})

test('Agent media mask preparation migration is additive, reversible and records immutable managed-byte provenance', () => {
  const migration = migrations.find(item => item.name === 'agent_media_preparations')!
  assert.equal(migration.version, '0045')
  assert.equal(migration.transactional, true)
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS agent_media_mask_preparations/)
  assert.match(migration.sql, /FOREIGN KEY\(upload_id, owner_id\) REFERENCES media_uploads\(id, created_by\)/)
  assert.match(migration.sql, /source_checksum.*mask_checksum.*width.*height.*preparation_version/s)
  assert.match(migration.sql, /BEFORE UPDATE OR DELETE ON agent_media_mask_preparations/)
  assert.match(readFileSync(new URL('../../rollback/0045_agent_media_preparations.sql', import.meta.url), 'utf8'), /DROP TABLE IF EXISTS agent_media_mask_preparations/)
})
