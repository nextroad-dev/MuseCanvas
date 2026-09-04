import assert from 'node:assert/strict'
import test from 'node:test'
import type pg from 'pg'
import {
  BillingError,
  BillingErrorCode,
  ensureCreditAccount,
  reserveGenerationCredits,
  captureGenerationCredits,
  adjustCredits,
  toSafeInt,
  toCreditBalance,
  type CreditAccountRow,
  type GenerationChargeRow,
  type CreditLedgerRow,
} from './transactions/billing'

test('toSafeInt and balance converters handle bigint strings and invalid inputs', () => {
  assert.equal(toSafeInt('123'), 123)
  assert.equal(toSafeInt(123), 123)
  assert.equal(toSafeInt(null, 0), 0)
  assert.throws(() => toSafeInt('abc'), { name: 'BillingError' })
  assert.throws(() => toSafeInt(1.5), { name: 'BillingError' })

  const balance = toCreditBalance({
    user_id: 'u1',
    available_credits: '100',
    reserved_credits: '50',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.equal(balance.userId, 'u1')
  assert.equal(balance.availableCredits, 100)
  assert.equal(balance.reservedCredits, 50)
  assert.equal(balance.totalCredits, 150)
  assert.throws(() => toCreditBalance({
    user_id: 'u1',
    available_credits: '9007199254740991',
    reserved_credits: '1',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  }), { name: 'BillingError' })
})

test('billing error codes match contracts standard', () => {
  assert.equal(BillingErrorCode.INSUFFICIENT_CREDITS, 'INSUFFICIENT_CREDITS')
  assert.equal(BillingErrorCode.GENERATION_PRICE_CHANGED, 'GENERATION_PRICE_CHANGED')
  assert.equal(BillingErrorCode.BILLING_STATE_CONFLICT, 'BILLING_STATE_CONFLICT')
  assert.equal(BillingErrorCode.INVALID_CREDIT_AMOUNT, 'INVALID_CREDIT_AMOUNT')
})

test('billing primitives mock client workflow: ensure, reserve, capture, release, adjust, and idempotency', async () => {
  const accounts: Record<string, CreditAccountRow> = {}
  const ledger: CreditLedgerRow[] = []
  const charges: Record<string, GenerationChargeRow> = {}

  const mockClient = {
    async query(sql: string, params: unknown[] = []) {
      const normalized = sql.trim().replace(/\s+/g, ' ')

      // SELECT * FROM credit_accounts WHERE user_id = $1
      if (normalized.startsWith('SELECT * FROM credit_accounts WHERE user_id = $1')) {
        const acc = accounts[params[0] as string]
        return { rows: acc ? [acc] : [] }
      }

      // INSERT INTO credit_accounts
      if (normalized.includes('INSERT INTO credit_accounts')) {
        const userId = params[0] as string
        const available = (params[1] ?? 0) as number
        if (!accounts[userId]) {
          const acc: CreditAccountRow = {
            user_id: userId,
            available_credits: available,
            reserved_credits: 0,
            created_at: new Date(),
            updated_at: new Date(),
          }
          accounts[userId] = acc
          return { rows: [acc] }
        }
        return { rows: [] }
      }

      // UPDATE credit_accounts
      if (normalized.includes('UPDATE credit_accounts')) {
        if (normalized.includes('SET available_credits = $1, reserved_credits = $2')) {
          const acc = accounts[params[2] as string]
          acc.available_credits = params[0] as number
          acc.reserved_credits = params[1] as number
          return { rows: [acc] }
        } else if (normalized.includes('SET reserved_credits = $1')) {
          const acc = accounts[params[1] as string]
          acc.reserved_credits = params[0] as number
          return { rows: [acc] }
        } else if (normalized.includes('SET available_credits = $1')) {
          const acc = accounts[params[1] as string]
          acc.available_credits = params[0] as number
          return { rows: [acc] }
        }
      }

      // SELECT * FROM generation_charges WHERE job_id = $1
      if (normalized.startsWith('SELECT * FROM generation_charges WHERE job_id = $1')) {
        const ch = charges[params[0] as string]
        return { rows: ch ? [ch] : [] }
      }

      // INSERT INTO generation_charges
      if (normalized.includes('INSERT INTO generation_charges')) {
        const ch: GenerationChargeRow = {
          job_id: params[0] as string,
          user_id: params[1] as string,
          quoted_credits: params[2] as number,
          state: 'reserved',
          billing_cycle: 1,
          pricing_snapshot: JSON.parse((params[3] as string) || '{}'),
          reserved_at: new Date(),
          settled_at: null,
          released_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        }
        charges[params[0] as string] = ch
        return { rows: [ch] }
      }

      // UPDATE generation_charges
      if (normalized.includes('UPDATE generation_charges')) {
        if (normalized.includes("SET state = 'settled'")) {
          const ch = charges[params[0] as string]
          ch.state = 'settled'
          ch.settled_at = new Date()
          return { rows: [ch] }
        }
        if (normalized.includes("SET state = 'released'")) {
          const ch = charges[params[0] as string]
          ch.state = 'released'
          ch.released_at = new Date()
          return { rows: [ch] }
        }
        if (normalized.includes("SET state = 'reserved'")) {
          const ch = charges[params[1] as string]
          ch.state = 'reserved'
          ch.billing_cycle = params[0] as number
          ch.reserved_at = new Date()
          ch.released_at = null
          return { rows: [ch] }
        }
      }

      // SELECT * FROM credit_ledger WHERE idempotency_key = $1
      if (normalized.startsWith('SELECT * FROM credit_ledger WHERE idempotency_key = $1')) {
        const found = ledger.filter((l) => l.idempotency_key === (params[0] as string))
        return { rows: found }
      }

      // INSERT INTO credit_ledger
      if (normalized.includes('INSERT INTO credit_ledger')) {
        const isAdjust = normalized.includes('VALUES ($1, $2, $3, 0,')
        const entry: CreditLedgerRow = isAdjust
          ? {
              id: 'ledger-' + (ledger.length + 1),
              user_id: params[0] as string,
              operation: params[1] as CreditLedgerRow['operation'],
              available_delta: params[2] as number,
              reserved_delta: 0,
              available_after: params[3] as number,
              reserved_after: params[4] as number,
              reference_type: params[5] as string | null,
              reference_id: params[6] as string | null,
              billing_cycle: null,
              idempotency_key: params[7] as string | null,
              created_by: params[8] as string | null,
              note: params[9] as string | null,
              created_at: new Date(),
            }
          : {
              id: 'ledger-' + (ledger.length + 1),
              user_id: params[0] as string,
              operation: params[1] as CreditLedgerRow['operation'],
              available_delta: params[2] as number,
              reserved_delta: params[3] as number,
              available_after: params[4] as number,
              reserved_after: params[5] as number,
              reference_type: params[6] as string | null,
              reference_id: params[7] as string | null,
              billing_cycle: params[8] as number | null,
              idempotency_key: (params[9] || params[7] || params[8]) as string | null,
              created_by: null,
              note: null,
              created_at: new Date(),
            }
        ledger.push(entry)
        return { rows: [entry] }
      }

      return { rows: [] }
    },
  } as unknown as pg.PoolClient

  // 1. Ensure account with grant
  const acc = await ensureCreditAccount(mockClient, 'user-1', { signupGrant: 100 })
  assert.equal(acc.availableCredits, 100)
  assert.equal(acc.reservedCredits, 0)

  // 2. Reserve credits
  const res1 = await reserveGenerationCredits(mockClient, {
    jobId: 'job-1',
    userId: 'user-1',
    quotedCredits: 40,
  })
  assert.equal(res1.account.availableCredits, 60)
  assert.equal(res1.account.reservedCredits, 40)
  assert.equal(res1.alreadyProcessed, false)

  // 3. Repeat reserve (idempotent)
  const res1Repeat = await reserveGenerationCredits(mockClient, {
    jobId: 'job-1',
    userId: 'user-1',
    quotedCredits: 40,
  })
  assert.equal(res1Repeat.alreadyProcessed, true)

  // 4. Capture credits
  const cap = await captureGenerationCredits(mockClient, { jobId: 'job-1' })
  assert.equal(cap.account.availableCredits, 60)
  assert.equal(cap.account.reservedCredits, 0)
  assert.equal(cap.charge.state, 'settled')

  // 5. Repeat capture (idempotent)
  const capRepeat = await captureGenerationCredits(mockClient, { jobId: 'job-1' })
  assert.equal(capRepeat.alreadyProcessed, true)

  // 6. Insufficient credits check
  await assert.rejects(
    async () => {
      await reserveGenerationCredits(mockClient, {
        jobId: 'job-2',
        userId: 'user-1',
        quotedCredits: 100, // available is 60
      })
    },
    (err: unknown) => err instanceof BillingError && err.code === BillingErrorCode.INSUFFICIENT_CREDITS
  )

  // 7. Adjust credits
  const adj = await adjustCredits(mockClient, {
    userId: 'user-1',
    amount: 50,
    idempotencyKey: 'adj-1',
  })
  assert.equal(adj.account.availableCredits, 110)
  assert.equal(adj.alreadyProcessed, false)
  const lastLedger = ledger[ledger.length - 1]
  assert.equal(lastLedger.operation, 'adjustment')

  // 8. Replay adjust credits with same key (idempotent)
  const adjRepeat = await adjustCredits(mockClient, {
    userId: 'user-1',
    amount: 50,
    idempotencyKey: 'adj-1',
  })
  assert.equal(adjRepeat.account.availableCredits, 110)
  assert.equal(adjRepeat.alreadyProcessed, true)

  // 9. Conflict adjust credits with mismatched amount
  await assert.rejects(
    async () => {
      await adjustCredits(mockClient, {
        userId: 'user-1',
        amount: 20,
        idempotencyKey: 'adj-1',
      })
    },
    (err: unknown) => err instanceof BillingError && err.code === BillingErrorCode.BILLING_STATE_CONFLICT
  )
  await assert.rejects(
    async () => {
      await adjustCredits(mockClient, {
        userId: 'user-1',
        amount: Number.MAX_SAFE_INTEGER,
        idempotencyKey: 'adj-overflow',
      })
    },
    (err: unknown) => err instanceof BillingError && err.code === BillingErrorCode.INVALID_CREDIT_AMOUNT
  )
})
