import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { db } from '@musecanvas/database'
import {
  assertWorkerSchema,
  REQUIRED_AGENT_COLUMNS,
  REQUIRED_AGENT_COLUMN_KEYS,
  REQUIRED_AGENT_MEDIA_COLUMNS,
  REQUIRED_AGENT_RECOVERY_INDEXES,
  WorkerAgentIndexSchemaRequiredError,
  WorkerAgentMediaSchemaRequiredError,
  REQUIRED_WORKER_OUTBOX_COLUMNS,
  REQUIRED_CLEANUP_COLUMNS,
  WorkerCleanupSchemaRequiredError,
  WorkerAgentSchemaRequiredError,
  WorkerSchemaRequiredError,
} from './schema-preflight'

const completeOutbox = () => REQUIRED_WORKER_OUTBOX_COLUMNS.map(column_name => ({ column_name }))
const completePreparation = () => REQUIRED_AGENT_MEDIA_COLUMNS.map(column_name => ({ column_name }))
const missingIndexes = (...names: string[]) => names.map(missing_index => ({ missing_index }))

test('Worker schema preflight requires actual 0042 columns even without any Agent enabled', async t => {
  const query = t.mock.method(db(), 'query', async () => ({ rows: REQUIRED_WORKER_OUTBOX_COLUMNS.filter(column => column !== 'quarantined_at' && column !== 'quarantine_code').map(column_name => ({ column_name })) }))
  await assert.rejects(assertWorkerSchema(), error => {
    assert.ok(error instanceof WorkerSchemaRequiredError)
    assert.equal(error.name, 'WORKER_SCHEMA_0042_REQUIRED')
    assert.deepEqual(error.missingColumns, ['quarantined_at', 'quarantine_code'])
    assert.match(error.message, /migration 0042/)
    return true
  })
  assert.match(String(query.mock.calls[0].arguments[0]), /to_regclass\('outbox_events'\)/)
  assert.equal(query.mock.callCount(), 1, '0042 failure must stop before the agent control-plane query')
})

test('Worker schema preflight accepts complete schema, rejects missing relation and propagates DB errors', async t => {
  const query = t.mock.method(db(), 'query', async (sql: string) => ({ rows: String(sql).includes("to_regclass('agent_media_mask_preparations')")
    ? completePreparation() : String(sql).includes('missing_index') ? [] : completeOutbox() }))
  await assertWorkerSchema()
  assert.equal(query.mock.callCount(), 5)
  assert.match(String(query.mock.calls[1].arguments[0]), /agent_turns/)
  query.mock.mockImplementation(async () => ({ rows: [] }))
  await assert.rejects(assertWorkerSchema(), WorkerSchemaRequiredError)
  const failure = new Error('DB_OFFLINE')
  query.mock.mockImplementation(async () => { throw failure })
  await assert.rejects(assertWorkerSchema(), error => error === failure)
})

test('Worker schema preflight requires migration 0043 Agent columns and groups every miss as table.column', async t => {
  const query = t.mock.method(db(), 'query', async (sql: string) => String(sql).includes("to_regclass('outbox_events')")
    ? { rows: completeOutbox() }
    : { rows: [{ missing_column: 'agent_turns.cancel_requested_at' }, { missing_column: 'outbox_events.dedupe_key' }] })

  await assert.rejects(assertWorkerSchema(), error => {
    assert.ok(error instanceof WorkerAgentSchemaRequiredError)
    assert.equal(error.name, 'WORKER_SCHEMA_0043_REQUIRED')
    assert.deepEqual(error.missingColumns, ['agent_turns.cancel_requested_at', 'outbox_events.dedupe_key'])
    assert.match(error.message, /migration 0043/)
    return true
  })

  const agentSql = String(query.mock.calls[1]?.arguments[0])
  assert.match(agentSql, /pg_catalog\.pg_attribute/)
  assert.match(agentSql, /pg_catalog\.to_regclass\(expected\.table_name\)/)
  for (const [table, column] of REQUIRED_AGENT_COLUMNS) assert.ok(agentSql.includes(`('${table}','${column}')`), `${table}.${column} missing from preflight query`)
})

test('Worker schema preflight reports all 0043 columns when the Agent relations are absent', async t => {
  const query = t.mock.method(db(), 'query', async (sql: string) => ({
    rows: String(sql).includes("to_regclass('outbox_events')")
      ? completeOutbox()
      : REQUIRED_AGENT_COLUMN_KEYS.map(missing_column => ({ missing_column })),
  }))
  await assert.rejects(assertWorkerSchema(), error => {
    assert.ok(error instanceof WorkerAgentSchemaRequiredError)
    assert.deepEqual(error.missingColumns, REQUIRED_AGENT_COLUMN_KEYS)
    return true
  })
  assert.equal(query.mock.callCount(), 2)
})

test('Worker schema preflight requires every 0044 recovery index', async t => {
  const present = t.mock.method(db(), 'query', async (sql: string) => ({
    rows: String(sql).includes("to_regclass('outbox_events')") ? completeOutbox()
      : String(sql).includes("to_regclass('agent_media_mask_preparations')") ? completePreparation()
        : [],
  }))
  await assertWorkerSchema()
  assert.equal(present.mock.callCount(), 5)
  const indexSql = String(present.mock.calls[3].arguments[0])
  assert.match(indexSql, /pg_catalog\.pg_indexes/)
  for (const name of REQUIRED_AGENT_RECOVERY_INDEXES) assert.ok(indexSql.includes(`('${name}')`), `${name} missing from preflight query`)

  const missing = 'agent_tool_calls_waiting_external_idx'
  const absent = t.mock.method(db(), 'query', async (sql: string) => ({
    rows: String(sql).includes("to_regclass('outbox_events')") ? completeOutbox()
      : String(sql).includes("to_regclass('agent_media_mask_preparations')") ? completePreparation()
        : String(sql).includes('missing_index') ? missingIndexes(missing) : [],
  }))
  await assert.rejects(assertWorkerSchema(), error => {
    assert.ok(error instanceof WorkerAgentIndexSchemaRequiredError)
    assert.equal(error.name, 'WORKER_SCHEMA_0044_INDEX_REQUIRED')
    assert.deepEqual(error.missingIndexes, [missing])
    assert.match(error.message, /migration 0044/)
    return true
  })
  assert.equal(absent.mock.callCount(), 4)
})

test('Worker schema preflight resolves when 0042 through 0046 checks are complete', async t => {
  const query = t.mock.method(db(), 'query', async (sql: string) => ({
    rows: String(sql).includes("to_regclass('outbox_events')") ? completeOutbox()
      : String(sql).includes("to_regclass('agent_media_mask_preparations')") ? completePreparation()
        : [],
  }))
  await assertWorkerSchema()
  assert.equal(query.mock.callCount(), 5)
})

test('Worker schema preflight rejects missing 0045 preparation columns before startup', async t => {
  t.mock.method(db(), 'query', async (sql: string) => ({
    rows: String(sql).includes("to_regclass('outbox_events')") ? completeOutbox() : [],
  }))
  await assert.rejects(assertWorkerSchema(), error => {
    assert.ok(error instanceof WorkerAgentMediaSchemaRequiredError)
    assert.equal(error.name, 'WORKER_SCHEMA_0045_REQUIRED')
    assert.deepEqual(error.missingColumns, REQUIRED_AGENT_MEDIA_COLUMNS.map(column => `agent_media_mask_preparations.${column}`))
    return true
  })
})

test('Worker schema preflight rejects missing 0046 cleanup claims before queues start', async t => {
  t.mock.method(db(), 'query', async (sql: string) => ({ rows: sql.includes("to_regclass('outbox_events')") ? completeOutbox()
    : sql.includes("to_regclass('agent_media_mask_preparations')") ? completePreparation()
      : sql.includes('missing_cleanup_column') ? REQUIRED_CLEANUP_COLUMNS.map(([table, column]) => ({ missing_cleanup_column: `${table}.${column}` })) : [] }))
  await assert.rejects(assertWorkerSchema(), error => {
    assert.ok(error instanceof WorkerCleanupSchemaRequiredError)
    assert.equal(error.name, 'WORKER_SCHEMA_0046_REQUIRED')
    assert.equal(error.missingColumns.length, 8)
    return true
  })
})

test('Worker startup places schema gate before Redis, health and scheduling; no services started by this test', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const gate = source.indexOf('await assertWorkerSchema()')
  assert.ok(gate > source.indexOf('assertBootstrapConfig()'))
  for (const start of ['await redisCommand(redis.connect())', 'startHealthServer(health)', 'await scheduleMaintenance()', 'consume(processJob', 'startAgentWorkers({']) assert.ok(source.indexOf(start) > gate, start)
  assert.match(source, /requiredMigration: '0042', missingColumns: error.missingColumns/)
  assert.match(source, /requiredMigration: '0045', missingColumns: error.missingColumns/)
  assert.match(source, /requiredMigration: '0044', missingIndexes: error.missingIndexes/)
  assert.match(source, /requiredMigration: '0043', missingColumns: error.missingColumns/)
  assert.match(source, /requiredMigration: '0046', missingColumns: error.missingColumns/)
  // Recovery must drain already admitted turns after the API feature flag is turned off.
  assert.ok(source.indexOf('void runCoordinator()') > gate)
  assert.ok(source.indexOf('setInterval(runCoordinator, agentRecoveryIntervalMs())') > gate)
  assert.doesNotMatch(source, /process\.env\.AGENT_CORE_ENABLED/)
})
