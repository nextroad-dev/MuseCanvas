import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { db, poolConfig } from './index'

test('pool config defaults are bounded and positive integer environment overrides are validated', () => {
  const names = ['DATABASE_POOL_MAX', 'DATABASE_CONNECTION_TIMEOUT_MS', 'DATABASE_IDLE_TIMEOUT_MS', 'DATABASE_STATEMENT_TIMEOUT_MS', 'DATABASE_LOCK_TIMEOUT_MS', 'DATABASE_IDLE_TRANSACTION_TIMEOUT_MS']
  const saved = new Map(names.map(name => [name, process.env[name]]))
  try {
    for (const name of names) delete process.env[name]
    const defaults = poolConfig()
    assert.equal(defaults.max, 12)
    assert.equal(defaults.connectionTimeoutMillis, 5000)
    assert.equal(defaults.idleTimeoutMillis, 30000)
    assert.equal(defaults.statement_timeout, 30000)
    assert.equal(defaults.lock_timeout, 5000)
    assert.equal(defaults.idle_in_transaction_session_timeout, 30000)
    process.env.DATABASE_POOL_MAX = '7'
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '45000'
    process.env.DATABASE_LOCK_TIMEOUT_MS = '-1'
    process.env.DATABASE_CONNECTION_TIMEOUT_MS = 'NaN'
    assert.equal(poolConfig().max, 7)
    assert.equal(poolConfig().statement_timeout, 45000)
    assert.equal(poolConfig().lock_timeout, 5000)
    assert.equal(poolConfig().connectionTimeoutMillis, 5000)
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('idle pool error listener logs a fixed code without upstream connection details', () => {
  const log = mock.method(console, 'error', () => {})
  try {
    const pool = db()
    assert.ok(pool.listenerCount('error') > 0)
    pool.emit('error', new Error('postgresql://private-user:private-password@internal'))
    assert.deepEqual(log.mock.calls[0]!.arguments, ['database idle connection error', { code: 'DATABASE_POOL_ERROR' }])
  } finally { log.mock.restore() }
})
