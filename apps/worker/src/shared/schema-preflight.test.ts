import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { db } from '@musecanvas/database'
import { assertWorkerSchema, REQUIRED_WORKER_OUTBOX_COLUMNS, WorkerSchemaRequiredError } from './schema-preflight'

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
})

test('Worker schema preflight accepts complete schema, rejects missing relation and propagates DB errors', async t => {
  const query = t.mock.method(db(), 'query', async () => ({ rows: REQUIRED_WORKER_OUTBOX_COLUMNS.map(column_name => ({ column_name })) }))
  await assertWorkerSchema()
  query.mock.mockImplementation(async () => ({ rows: [] }))
  await assert.rejects(assertWorkerSchema(), WorkerSchemaRequiredError)
  const failure = new Error('DB_OFFLINE')
  query.mock.mockImplementation(async () => { throw failure })
  await assert.rejects(assertWorkerSchema(), error => error === failure)
})

test('Worker startup places schema gate before Redis, health and scheduling; no services started by this test', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const gate = source.indexOf('await assertWorkerSchema()')
  assert.ok(gate > source.indexOf('assertBootstrapConfig()'))
  for (const start of ['await redisCommand(redis.connect())', 'startHealthServer(health)', 'await scheduleMaintenance()', 'await consume(processJob']) assert.ok(source.indexOf(start) > gate, start)
  assert.match(source, /requiredMigration: '0042', missingColumns: error.missingColumns/)
})
