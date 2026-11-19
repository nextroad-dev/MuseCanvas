import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFixtures, requireFixtureUrl, validateFixtureTap } from './run-agent-fixture.mjs'

const title = agentFixtures.runtime.title
const tap = `TAP version 13\nok 1 - ${title}\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`

test('requires explicit safe per-suite configuration before starting tests', () => {
  for (const suite of Object.keys(agentFixtures)) {
    assert.throws(() => requireFixtureUrl(suite, {}), /Required fixture variable missing/)
    const key = agentFixtures[suite].env
    assert.throws(() => requireFixtureUrl(suite, { [key]: 'postgresql://fixture@remote/postgres' }), /Unsafe/)
    const value = suite === 'streams' ? 'redis://127.0.0.1:6379/15' : 'postgresql://fixture@127.0.0.1:5432/postgres'
    assert.equal(requireFixtureUrl(suite, { [key]: value }), agentFixtures[suite])
  }
  assert.throws(() => requireFixtureUrl('other', {}), /Unknown fixture suite/)
})

test('accepts TAP only when the expected suite and all assertions pass without skips', () => {
  assert.equal(validateFixtureTap(tap, title, 0), 1)
  for (const output of [
    tap.replace(`ok 1 - ${title}`, `ok 1 - ${title} # SKIP`).replace('# skipped 0', '# skipped 1'),
    tap.replace('# tests 1', '# tests 0').replace('# pass 1', '# pass 0'),
    tap.replace(title, 'another test'),
    tap.replace('# fail 0', '# fail 1'),
    tap.replace('# skipped 0\n', ''),
    tap.replace('1..1\n', ''),
    tap.replace('1..1', '1..2'),
    tap.replace('1..1', '1..1\n1..1'),
    tap.replace('# skipped 0', '# skipped 1\n# skipped 0'),
    tap.replace('# pass 1', '# pass 1\n# pass 1'),
    tap.replace('# tests 1', '# tests 9007199254740993').replace('# pass 1', '# pass 9007199254740993'),
    tap.replace('1..1', 'ok 2 - unexpected test\n1..1'),
    tap.replace('1..1', 'Bail out! incomplete fixture\n1..1'),
    '',
  ]) assert.throws(() => validateFixtureTap(output, title, 0))
  assert.throws(() => validateFixtureTap(tap, title, 1), /exited 1/)
})

test('validates actual Node TAP subtests and refuses a nested skipped fixture', t => {
  const directory = mkdtempSync(join(tmpdir(), 'musecanvas-tap-protocol-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'protocol.test.mjs')
  const env = { ...process.env }
  // Model the standalone CI entry, without the enclosing Node test runner's private transport.
  delete env.NODE_TEST_CONTEXT
  for (const skip of [false, true]) {
    writeFileSync(file, `import test from 'node:test'; test(${JSON.stringify(title)}, async t => { await t.test('first', () => {}); await t.test('second', { skip: ${skip} }, () => {}); });\n`)
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { env, encoding: 'utf8' })
    assert.equal(result.status, 0)
    if (skip) assert.throws(() => validateFixtureTap(result.stdout, title, result.status))
    else {
      assert.equal(validateFixtureTap(result.stdout, title, result.status), 3)
      assert.equal(validateFixtureTap(result.stdout.replaceAll('\n', '\r\n'), title, result.status), 3)
    }
  }
})

test('CI entry exits nonzero on missing URL rather than silently skipping', () => {
  const env = { ...process.env }
  for (const fixture of Object.values(agentFixtures)) delete env[fixture.env]
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run-agent-fixture.mjs', import.meta.url)), 'runtime'], { env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Required fixture variable missing: MUSECANVAS_AGENT_RUNTIME_PG_URL/)
  assert.equal(result.stdout, '')
})
