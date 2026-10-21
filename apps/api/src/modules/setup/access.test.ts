import assert from 'node:assert/strict'
import test from 'node:test'

import { setupOpenWithoutClaim, type SetupOpenFacts } from './access'

// Matrix for SETUP_CLAIM_REQUIRED=false: setup is open without a cookie only while onboarding
// is incomplete and no active admin exists. Every other cell keeps the existing cookie/admin rule.

function facts(onboardingComplete: boolean, activeAdminCount: number): () => Promise<SetupOpenFacts> {
  return async () => ({ onboardingComplete, activeAdminCount })
}

test('claim required keeps setup closed whatever the onboarding and admin state', async () => {
  for (const complete of [false, true]) {
    for (const admins of [0, 1]) {
      assert.equal(await setupOpenWithoutClaim(true, facts(complete, admins)), false, `complete=${complete} admins=${admins}`)
    }
  }
})

test('claim required never reads the facts, so the default path touches no database', async () => {
  let reads = 0
  const open = await setupOpenWithoutClaim(true, async () => {
    reads += 1
    return { onboardingComplete: false, activeAdminCount: 0 }
  })
  assert.equal(open, false)
  assert.equal(reads, 0)
})

test('claim optional is open only while onboarding is incomplete and no active admin exists', async () => {
  assert.equal(await setupOpenWithoutClaim(false, facts(false, 0)), true)
})

test('claim optional closes as soon as an active admin exists', async () => {
  assert.equal(await setupOpenWithoutClaim(false, facts(false, 1)), false)
  assert.equal(await setupOpenWithoutClaim(false, facts(false, 2)), false)
})

test('claim optional closes once onboarding is complete, even with no admin left', async () => {
  assert.equal(await setupOpenWithoutClaim(false, facts(true, 0)), false)
  assert.equal(await setupOpenWithoutClaim(false, facts(true, 1)), false)
})

test('a failed fact read fails closed in both modes', async () => {
  const broken = async (): Promise<SetupOpenFacts> => {
    throw new Error('connection refused')
  }
  assert.equal(await setupOpenWithoutClaim(false, broken), false)
  assert.equal(await setupOpenWithoutClaim(true, broken), false)
})

test('a malformed admin count is not treated as zero', async () => {
  const malformed = async () => ({ onboardingComplete: false, activeAdminCount: undefined as unknown as number })
  assert.equal(await setupOpenWithoutClaim(false, malformed), false)
})
