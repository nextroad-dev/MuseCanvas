import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const agentFixtures = {
  runtime: { env: 'MUSECANVAS_AGENT_RUNTIME_PG_URL', file: 'agent-runtime-pg.test.ts', title: 'isolated PostgreSQL: Agent runtime leases and SQL transaction fencing' },
  recovery: { env: 'MUSECANVAS_AGENT_RECOVERY_PG_URL', file: 'agent-recovery-pg.test.ts', title: 'isolated PostgreSQL: Agent recovery persistence sweeps' },
  media: { env: 'MUSECANVAS_AGENT_MEDIA_TERMINAL_PG_URL', file: 'agent-media-terminal-pg.test.ts', title: 'isolated PostgreSQL: Agent media terminal/dedupe/owner/outbox fault matrix' },
  cleanup: { env: 'MUSECANVAS_AGENT_CLEANUP_PG_URL', file: 'agent-cleanup-pg.test.ts', title: 'isolated PostgreSQL: cleanup claims, rollback and account convergence guards' },
  streams: { env: 'MUSECANVAS_AGENT_STREAMS_REDIS_URL', file: 'agent-streams-redis.test.ts', title: 'isolated Redis: Agent wake/media route contract, independent groups and replay semantics' },
}

export function requireFixtureUrl(suite, env = process.env) {
  const fixture = Object.hasOwn(agentFixtures, suite) ? agentFixtures[suite] : undefined
  if (!fixture) throw new Error('Unknown fixture suite; use runtime, recovery, media, cleanup or streams')
  const value = env[fixture.env]
  if (!value?.trim()) throw new Error(`Required fixture variable missing: ${fixture.env}`)
  let url
  try { url = new URL(value) } catch { throw new Error(`Invalid isolated fixture URL: ${fixture.env}`) }
  const valid = suite === 'streams'
    ? url.protocol === 'redis:' && url.hostname === '127.0.0.1' && url.pathname === '/15'
    : ['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.username === 'fixture' && url.pathname === '/postgres'
  if (!valid || url.search || url.hash) throw new Error(`Unsafe isolated fixture target: ${fixture.env}`)
  return fixture
}

/** A zero exit with absent/skipped fixture assertions is not a verified CI run. */
export function validateFixtureTap(output, title, exitCode) {
  if (exitCode !== 0) throw new Error(`Fixture process exited ${exitCode}`)
  const lines = output.split(/\r?\n/)
  const topLevel = lines.filter(line => /^(?:not )?ok \d+\b/.test(line))
  if (topLevel.length !== 1 || topLevel[0] !== `ok 1 - ${title}`) throw new Error('Expected top-level fixture did not pass without skip')
  const plans = lines.filter(line => /^\d+\.\.\d+/.test(line))
  if (plans.length !== 1 || plans[0] !== '1..1') throw new Error('Expected exactly one complete top-level TAP plan')
  if (lines.some(line => /^\s*(?:not ok\b|Bail out!)/.test(line))) throw new Error('Fixture TAP contains a failed assertion or bailout')
  const counts = new Map()
  for (const match of output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/gm)) {
    const value = Number(match[2])
    if (counts.has(match[1]) || !Number.isSafeInteger(value)) throw new Error('Duplicate or invalid fixture TAP statistic')
    counts.set(match[1], value)
  }
  if (!(counts.get('tests') > 0) || counts.get('pass') !== counts.get('tests')) throw new Error('Fixture reported no complete passing assertions')
  for (const kind of ['fail', 'cancelled', 'skipped', 'todo']) {
    if (counts.get(kind) !== 0) throw new Error(`Fixture ${kind} count must be explicitly zero`)
  }
  return counts.get('pass')
}

export async function runAgentFixture(suite) {
  const fixture = requireFixtureUrl(suite)
  const require = createRequire(resolve(root, 'packages/providers/package.json'))
  const loader = pathToFileURL(require.resolve('tsx')).href
  const args = ['--import', loader, '--test', '--test-reporter=tap', resolve(root, 'tests/integration', fixture.file)]
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', code => resolveExit(code))
  })
  const count = validateFixtureTap(output, fixture.title, exitCode)
  console.log(`Verified ${suite} fixture: ${count} passed, zero skipped`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAgentFixture(process.argv[2]).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
