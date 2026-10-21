import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { NextRequest } from 'next/server'
import type { transaction } from '@musecanvas/database'

import { ensureSetupClaim, setupClaim, setupStatus } from './handlers'

type Env = Record<string, string | undefined>

async function withEnv<T>(overrides: Env, fn: () => Promise<T>): Promise<T> {
  const env = process.env as Env
  const saved = Object.keys(overrides).map((key) => [key, env[key]] as const)
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  }
}

/** A transaction stand-in that records every call and every SQL statement, returning no rows. */
function recordingTransaction(): { run: typeof transaction; sql: string[]; calls: () => number } {
  const sql: string[] = []
  let calls = 0
  const client = {
    query: async (text: string) => {
      sql.push(text)
      return { rows: [] }
    },
  }
  const run = (async (fn: (c: unknown) => Promise<unknown>) => {
    calls += 1
    return fn(client)
  }) as unknown as typeof transaction
  return { run, sql, calls: () => calls }
}

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: unknown[][] }> {
  const output: unknown[][] = []
  const { log, error, warn } = console
  console.log = (...args: unknown[]) => { output.push(args) }
  console.error = (...args: unknown[]) => { output.push(args) }
  console.warn = (...args: unknown[]) => { output.push(args) }
  try {
    return { result: await fn(), output }
  } finally {
    console.log = log
    console.error = error
    console.warn = warn
  }
}

test('claim-optional mode mints nothing: no transaction, no stdout, no file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'musecanvas-claim-optional-'))
  const tx = recordingTransaction()
  const env: Env = {
    SETUP_CLAIM_REQUIRED: 'false',
    NODE_ENV: 'development',
    SETUP_CLAIM_DELIVERY: 'log',
    SETUP_CLAIM_FILE: join(dir, 'claim'),
  }
  const { output } = await captureConsole(() => ensureSetupClaim(env, tx.run))
  assert.equal(tx.calls(), 0, 'no claim row is read, locked or written')
  assert.deepEqual(output, [], 'no claim block or message reaches the console')
  assert.deepEqual(readdirSync(dir), [], 'no claim file is written')
})

test('claim-required mode still runs the claim install path (positive control)', async () => {
  const tx = recordingTransaction()
  await captureConsole(() => ensureSetupClaim({ NODE_ENV: 'development' }, tx.run))
  assert.equal(tx.calls(), 1)
  assert.ok(tx.sql.some((text) => text.includes('FOR UPDATE')), 'the claim row is locked before any decision')
})

test('POST setup/claim answers 409 SETUP_CLAIM_NOT_REQUIRED when the claim is optional', async () => {
  const response = await withEnv({ SETUP_CLAIM_REQUIRED: 'false' }, () =>
    setupClaim(new NextRequest('http://localhost/api/setup/claim', { method: 'POST' }), { code: 'anything' }),
  )
  assert.equal(response.status, 409)
  const payload = await response.json() as { success: boolean; error: { code: string; message: string } }
  assert.equal(payload.success, false)
  assert.equal(payload.error.code, 'SETUP_CLAIM_NOT_REQUIRED')
  assert.match(payload.error.message, /无需领取码/)
})

// Unreachable endpoints fail fast, so the status poll reports a pending onboarding without a database.
const UNREACHABLE: Env = {
  DATABASE_URL: 'postgresql://musecanvas:unused@127.0.0.1:1/musecanvas',
  REDIS_URL: 'redis://127.0.0.1:1',
}

test('GET setup/status reports claimRequired from SETUP_CLAIM_REQUIRED', async () => {
  for (const [raw, expected] of [
    [undefined, true],
    ['true', true],
    ['false', false],
    [' FALSE ', false],
  ] as const) {
    const response = await withEnv({ ...UNREACHABLE, SETUP_CLAIM_REQUIRED: raw }, () => setupStatus())
    assert.equal(response.status, 200)
    const payload = await response.json() as { success: boolean; data: { claimRequired: boolean; setupComplete: boolean } }
    assert.equal(payload.success, true)
    assert.equal(payload.data.claimRequired, expected, `SETUP_CLAIM_REQUIRED=${raw}`)
    assert.equal(payload.data.setupComplete, false)
  }
})
