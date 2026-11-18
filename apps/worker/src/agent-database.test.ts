import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentDatabasePorts, type AgentDatabaseClient } from './agent-database'

function fixture() {
  const calls: Array<{ text: string; values: unknown[]; timeout?: number }> = []
  const releases: Array<boolean | undefined> = []
  let fail = false
  const client = {
    async query(input: string | { text: string; values: unknown[]; query_timeout: number }, values: unknown[] = []) {
      const text = typeof input === 'string' ? input : input.text
      calls.push({ text, values: typeof input === 'string' ? values : input.values,
        timeout: typeof input === 'string' ? undefined : input.query_timeout })
      if (fail && text === 'SELECT bound_model') throw new Error('injected SQL failure')
      return { rows: text === 'SELECT bound_model' ? [{ id: 'model' }] : [], rowCount: 1 }
    },
    release(destroy?: boolean) { releases.push(destroy) },
  } as unknown as AgentDatabaseClient
  const pool = { async connect() { return client } }
  return { client, pool, calls, releases, failQuery() { fail = true } }
}

test('Agent database context reads have a repeatable read snapshot and release before returning', async () => {
  const f = fixture()
  const ports = createAgentDatabasePorts(f.pool)
  await ports.readTransaction(async sql => { await sql.query('SELECT items'); await sql.query('SELECT turns') })
  assert.deepEqual(f.calls.map(call => call.text), [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
    'SELECT items', 'SELECT turns', 'COMMIT',
  ])
  assert.deepEqual(f.releases, [false])
})

test('Agent model lookup uses its deadline as local server and driver timeout and releases its client', async () => {
  const f = fixture()
  const ports = createAgentDatabasePorts(f.pool)
  const result = await ports.modelQuery('SELECT bound_model', ['revision'], { signal: new AbortController().signal, timeoutMs: 400 })
  assert.deepEqual(result.rows, [{ id: 'model' }])
  assert.equal(f.calls[0]!.text, 'BEGIN READ ONLY')
  const timeout = Number(f.calls[1]!.values[0])
  assert.ok(timeout > 0 && timeout <= 400)
  assert.ok(f.calls[2]!.timeout! > 0 && f.calls[2]!.timeout! <= timeout)
  assert.deepEqual(f.calls[2]!.values, ['revision'])
  assert.equal(f.calls.at(-1)!.text, 'COMMIT')
  assert.deepEqual(f.releases, [false])
})

test('Agent model lookup destroys the connection on query failure to terminate any server-side transaction', async () => {
  const f = fixture(); f.failQuery()
  await assert.rejects(createAgentDatabasePorts(f.pool).modelQuery('SELECT bound_model', []), /injected SQL failure/)
  assert.equal(f.calls.at(-1)!.text, 'SELECT bound_model')
  assert.deepEqual(f.releases, [true])
})

test('Cancel while acquiring model connection rejects promptly and releases the late connection without querying', async () => {
  const f = fixture()
  let complete!: (client: AgentDatabaseClient) => void
  const pool = { connect: () => new Promise<AgentDatabaseClient>(resolve => { complete = resolve }) }
  const controller = new AbortController()
  const pending = createAgentDatabasePorts(pool).modelQuery('SELECT bound_model', [], { signal: controller.signal, timeoutMs: 1000 })
  controller.abort()
  await assert.rejects(pending, /AGENT_DATABASE_CANCELED/)
  complete(f.client)
  await Promise.resolve()
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.releases, [undefined])
})

test('Already canceled lookup never acquires a connection', async () => {
  let acquired = 0
  const pool = { async connect() { acquired++; throw new Error('must not connect') } }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(createAgentDatabasePorts(pool).modelQuery('SELECT bound_model', [], { signal: controller.signal, timeoutMs: 1000 }), /AGENT_DATABASE_CANCELED/)
  assert.equal(acquired, 0)
})

for (const stalled of ['BEGIN READ ONLY', "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)", 'COMMIT']) {
  test(`Model database abort destroys a client stalled in ${stalled}`, async () => {
    const released: boolean[] = []
    const queried: string[] = []
    const controller = new AbortController()
    let reach!: () => void
    const reached = new Promise<void>(resolve => { reach = resolve })
    let rejectLate!: (error: Error) => void
    const client = {
      async query(query: { text: string; query_timeout: number }) {
        assert.ok(query.query_timeout > 0 && query.query_timeout <= 1000)
        queried.push(query.text)
        if (query.text === stalled) {
          reach()
          return new Promise((_, reject) => { rejectLate = reject })
        }
        return { rows: [], rowCount: 0 }
      },
      release(destroy?: boolean) { released.push(destroy === true) },
    } as unknown as AgentDatabaseClient
    const ports = createAgentDatabasePorts({ async connect() { return client } })
    const pending = ports.modelQuery('SELECT bound_model', [], { signal: controller.signal, timeoutMs: 1000 })
    await reached
    controller.abort()
    await assert.rejects(pending, /AGENT_DATABASE_CANCELED/)
    assert.deepEqual(released, [true])
    assert.equal(queried.at(-1), stalled)
    rejectLate(new Error('late driver rejection'))
    await Promise.resolve()
    assert.deepEqual(released, [true])
  })
}
