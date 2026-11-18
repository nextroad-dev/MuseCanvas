import assert from 'node:assert/strict'
import test from 'node:test'
import { createProductionAgentComposition } from './agent-production'
import type { AgentDatabasePool } from './agent-database'

test('production composition is constructed lazily with the media policy wiring', () => {
  let touched = 0
  const pool: AgentDatabasePool = {
    async connect() { touched++; throw new Error('NO_IO_AT_CONSTRUCTION') },
  }
  const composition = createProductionAgentComposition(pool)
  assert.equal(touched, 0, 'no pool connection may happen while building the composition')
  assert.equal(typeof composition.createRunner, 'function')
  assert.equal(typeof composition.mediaEvents, 'function')
})
