import assert from 'node:assert/strict'
import test from 'node:test'

import { SETUP_DATABASE_DRIVERS } from '@musecanvas/contracts'
import { parseDatabaseConnection, shapeDatabaseStatus } from './database-status'

const PASSWORD = 'S3cret-Pass-Value'
const URL_WITH_SECRETS = `postgresql://musecanvas:${PASSWORD}@db.internal:6543/musecanvas?sslmode=require&password=${PASSWORD}`

test('the connection summary keeps host, port, database and user but never the password or query', () => {
  assert.deepEqual(parseDatabaseConnection(URL_WITH_SECRETS), {
    host: 'db.internal',
    port: 6543,
    database: 'musecanvas',
    user: 'musecanvas',
  })
})

test('the postgres scheme alias is accepted and the default port is reported when none is given', () => {
  assert.deepEqual(parseDatabaseConnection('postgres://app@localhost/muse'), {
    host: 'localhost',
    port: 5432,
    database: 'muse',
    user: 'app',
  })
})

test('percent-encoded user and database names are decoded, and a password with an encoded @ is dropped', () => {
  const summary = parseDatabaseConnection('postgresql://mu%40se:p%40ss@db/my%20db')
  assert.deepEqual(summary, { host: 'db', port: 5432, database: 'my db', user: 'mu@se' })
  assert.equal(JSON.stringify(summary).includes('p%40ss'), false)
  assert.equal(JSON.stringify(summary).includes('p@ss'), false)
})

test('a missing, unparseable or non-postgres URL yields no summary', () => {
  for (const raw of [undefined, '', 'not a url', 'mysql://user:pw@host/db', 'https://example.test/db']) {
    assert.equal(parseDatabaseConnection(raw), null, String(raw))
  }
})

test('a serialized status for a reachable database contains no password and no URL', () => {
  const dto = shapeDatabaseStatus({
    connection: parseDatabaseConnection(URL_WITH_SECRETS),
    reachable: true,
    serverVersion: '16.4',
    schemaVersion: '0040',
  })
  const serialized = JSON.stringify(dto)
  assert.equal(serialized.includes(PASSWORD), false)
  assert.equal(serialized.includes('postgresql://'), false)
  assert.equal(serialized.includes('sslmode'), false)
  assert.equal(serialized.includes('password'), false)
  assert.deepEqual(Object.keys(dto.connection).sort(), ['database', 'host', 'port', 'user'])
  assert.equal(dto.driver, 'postgres')
  assert.equal(dto.reachable, true)
  assert.equal(dto.serverVersion, '16.4')
  assert.equal(dto.schemaVersion, '0040')
})

test('an unreachable database reports no version facts even when the probe supplied some', () => {
  const dto = shapeDatabaseStatus({
    connection: parseDatabaseConnection(URL_WITH_SECRETS),
    reachable: false,
    serverVersion: '16.4',
    schemaVersion: '0040',
  })
  assert.equal(dto.reachable, false)
  assert.equal(dto.serverVersion, null)
  assert.equal(dto.schemaVersion, null)
  assert.equal(dto.connection.host, 'db.internal')
  assert.equal(JSON.stringify(dto).includes(PASSWORD), false)
})

test('an unparseable URL reports empty connection fields and reachable false', () => {
  const dto = shapeDatabaseStatus({ connection: null, reachable: true, serverVersion: '16.4', schemaVersion: '0040' })
  assert.deepEqual(dto.connection, { host: null, port: null, database: null, user: null })
  assert.equal(dto.reachable, false)
  assert.equal(dto.serverVersion, null)
  assert.equal(dto.schemaVersion, null)
})

test('the driver list is a copy of the contract list, so a consumer cannot mutate the shared catalogue', () => {
  const dto = shapeDatabaseStatus({ connection: null, reachable: false, serverVersion: null, schemaVersion: null })
  assert.deepEqual(dto.availableDrivers, SETUP_DATABASE_DRIVERS)
  dto.availableDrivers[0].available = false
  assert.equal(SETUP_DATABASE_DRIVERS[0].available, true)
})
