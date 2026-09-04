import type pg from 'pg'

export type BillingState = 'reserved' | 'settled' | 'released'
export type CreditLedgerOperation = 'grant' | 'adjustment' | 'reservation' | 'capture' | 'release'

export const BillingErrorCode = {
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  GENERATION_PRICE_CHANGED: 'GENERATION_PRICE_CHANGED',
  BILLING_STATE_CONFLICT: 'BILLING_STATE_CONFLICT',
  INVALID_CREDIT_AMOUNT: 'INVALID_CREDIT_AMOUNT',
} as const

export type BillingErrorCode = (typeof BillingErrorCode)[keyof typeof BillingErrorCode]

export const INSUFFICIENT_CREDITS = BillingErrorCode.INSUFFICIENT_CREDITS
export const GENERATION_PRICE_CHANGED = BillingErrorCode.GENERATION_PRICE_CHANGED
export const BILLING_STATE_CONFLICT = BillingErrorCode.BILLING_STATE_CONFLICT
export const INVALID_CREDIT_AMOUNT = BillingErrorCode.INVALID_CREDIT_AMOUNT

export class BillingError extends Error {
  readonly code: BillingErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: BillingErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message || code)
    this.name = 'BillingError'
    this.code = code
    this.details = details
  }
}

export interface CreditAccountRow {
  user_id: string
  available_credits: string | number
  reserved_credits: string | number
  created_at: Date | string
  updated_at: Date | string
}

export interface CreditLedgerRow {
  id: string
  user_id: string
  operation: CreditLedgerOperation
  available_delta: string | number
  reserved_delta: string | number
  available_after: string | number
  reserved_after: string | number
  reference_type: string | null
  reference_id: string | null
  billing_cycle: number | null
  idempotency_key: string | null
  created_by: string | null
  note: string | null
  created_at: Date | string
}

export interface GenerationChargeRow {
  job_id: string
  user_id: string
  quoted_credits: string | number
  state: BillingState
  billing_cycle: number
  pricing_snapshot: Record<string, unknown>
  reserved_at: Date | string
  settled_at: Date | string | null
  released_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

export interface BillingSettingsRow {
  singleton: boolean
  enabled: boolean
  signup_grant: string | number
  updated_by: string | null
  updated_at: Date | string
}

export interface CreditBalance {
  userId: string
  availableCredits: number
  reservedCredits: number
  totalCredits: number
  updatedAt?: string
}

export interface CreditAccountEntity {
  userId: string
  availableCredits: number
  reservedCredits: number
  totalCredits: number
  createdAt: string
  updatedAt: string
}

export interface GenerationBilling {
  jobId: string
  userId: string
  state: BillingState
  billingCycle: number
  quotedCredits: number
  pricingSnapshot: Record<string, unknown>
  reservedAt?: string | null
  settledAt?: string | null
  releasedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type GenerationChargeEntity = GenerationBilling

export function toSafeInt(val: string | number | null | undefined, fallback = 0): number {
  if (val === null || val === undefined) return fallback
  if (typeof val === 'number') {
    if (!Number.isSafeInteger(val)) {
      throw new BillingError(INVALID_CREDIT_AMOUNT, `Value is not a safe integer: ${val}`)
    }
    return val
  }
  const parsed = Number(val)
  if (!Number.isSafeInteger(parsed)) {
    throw new BillingError(INVALID_CREDIT_AMOUNT, `Parsed value is not a safe integer: ${val}`)
  }
  return parsed
}

function safeTotalCredits(available: number, reserved: number): number {
  const total = available + reserved
  if (!Number.isSafeInteger(total)) {
    throw new BillingError(INVALID_CREDIT_AMOUNT, `Credit balance exceeds safe integer range: available=${available}, reserved=${reserved}`)
  }
  return total
}

export function toCreditBalance(row: CreditAccountRow): CreditBalance {
  const available = toSafeInt(row.available_credits)
  const reserved = toSafeInt(row.reserved_credits)
  return {
    userId: row.user_id,
    availableCredits: available,
    reservedCredits: reserved,
    totalCredits: safeTotalCredits(available, reserved),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : (row.updated_at ? String(row.updated_at) : undefined),
  }
}

export function toGenerationBilling(row: GenerationChargeRow): GenerationBilling {
  return {
    jobId: row.job_id,
    userId: row.user_id,
    state: row.state,
    billingCycle: Number(row.billing_cycle),
    quotedCredits: toSafeInt(row.quoted_credits),
    pricingSnapshot: typeof row.pricing_snapshot === 'string' ? JSON.parse(row.pricing_snapshot) : row.pricing_snapshot,
    reservedAt: row.reserved_at instanceof Date ? row.reserved_at.toISOString() : (row.reserved_at ? String(row.reserved_at) : null),
    settledAt: row.settled_at instanceof Date ? row.settled_at.toISOString() : (row.settled_at ? String(row.settled_at) : null),
    releasedAt: row.released_at instanceof Date ? row.released_at.toISOString() : (row.released_at ? String(row.released_at) : null),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}

export function toCreditAccountEntity(row: CreditAccountRow): CreditAccountEntity {
  const available = toSafeInt(row.available_credits)
  const reserved = toSafeInt(row.reserved_credits)
  return {
    userId: row.user_id,
    availableCredits: available,
    reservedCredits: reserved,
    totalCredits: safeTotalCredits(available, reserved),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }
}

export const toGenerationChargeEntity = toGenerationBilling

export interface EnsureCreditAccountOptions {
  signupGrant?: number
  idempotencyKey?: string
  createdBy?: string | null
  note?: string | null
}

export async function ensureCreditAccount(
  client: pg.PoolClient,
  userId: string,
  options?: EnsureCreditAccountOptions
): Promise<CreditAccountEntity> {
  const existingRes = await client.query<CreditAccountRow>(
    `SELECT * FROM credit_accounts WHERE user_id = $1`,
    [userId]
  )
  if (existingRes.rows.length > 0) {
    return toCreditAccountEntity(existingRes.rows[0])
  }

  const grantAmount = options?.signupGrant !== undefined ? options.signupGrant : 0
  if (!Number.isSafeInteger(grantAmount) || grantAmount < 0) {
    throw new BillingError(INVALID_CREDIT_AMOUNT, `signupGrant must be a non-negative safe integer: ${grantAmount}`)
  }

  if (grantAmount === 0) {
    const insertRes = await client.query<CreditAccountRow>(
      `INSERT INTO credit_accounts (user_id, available_credits, reserved_credits)
       VALUES ($1, 0, 0)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING *`,
      [userId]
    )
    if (insertRes.rows.length > 0) {
      return toCreditAccountEntity(insertRes.rows[0])
    }
    const reload = await client.query<CreditAccountRow>(
      `SELECT * FROM credit_accounts WHERE user_id = $1`,
      [userId]
    )
    return toCreditAccountEntity(reload.rows[0])
  }

  // grantAmount > 0
  const insertRes = await client.query<CreditAccountRow>(
    `INSERT INTO credit_accounts (user_id, available_credits, reserved_credits)
     VALUES ($1, $2, 0)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING *`,
    [userId, grantAmount]
  )

  if (insertRes.rows.length > 0) {
    const row = insertRes.rows[0]
    const idemKey = options?.idempotencyKey || `signup_grant:${userId}`
    await client.query(
      `INSERT INTO credit_ledger (
        user_id, operation, available_delta, reserved_delta,
        available_after, reserved_after, reference_type, reference_id,
        billing_cycle, idempotency_key, created_by, note
      ) VALUES ($1, 'grant', $2, 0, $3, 0, 'signup_grant', $1, 1, $4, $5, $6)
      ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        userId,
        grantAmount,
        grantAmount,
        idemKey,
        options?.createdBy ?? null,
        options?.note ?? 'Signup credit grant',
      ]
    )
    return toCreditAccountEntity(row)
  }

  // If conflict occurred, reload account
  const reload = await client.query<CreditAccountRow>(
    `SELECT * FROM credit_accounts WHERE user_id = $1`,
    [userId]
  )
  return toCreditAccountEntity(reload.rows[0])
}

export async function getCreditAccount(
  client: pg.PoolClient,
  userId: string
): Promise<CreditAccountEntity | null> {
  const res = await client.query<CreditAccountRow>(
    `SELECT * FROM credit_accounts WHERE user_id = $1`,
    [userId]
  )
  if (res.rows.length === 0) return null
  return toCreditAccountEntity(res.rows[0])
}

export async function getCreditBalance(
  client: pg.PoolClient,
  userId: string
): Promise<CreditBalance | null> {
  const res = await client.query<CreditAccountRow>(
    `SELECT * FROM credit_accounts WHERE user_id = $1`,
    [userId]
  )
  if (res.rows.length === 0) return null
  return toCreditBalance(res.rows[0])
}

export interface ReserveGenerationCreditsInput {
  jobId: string
  userId: string
  quotedCredits: number
  pricingSnapshot?: Record<string, unknown>
  idempotencyKey?: string
}

export interface ReserveGenerationCreditsResult {
  charge: GenerationChargeEntity
  account: CreditAccountEntity
  alreadyProcessed: boolean
}

export async function reserveGenerationCredits(
  client: pg.PoolClient,
  input: ReserveGenerationCreditsInput
): Promise<ReserveGenerationCreditsResult> {
  const { jobId, userId, quotedCredits, pricingSnapshot = {} } = input
  if (!Number.isSafeInteger(quotedCredits) || quotedCredits < 0) {
    throw new BillingError(INVALID_CREDIT_AMOUNT, `quotedCredits must be a non-negative safe integer: ${quotedCredits}`)
  }

  // Lock account
  const accountRes = await client.query<CreditAccountRow>(
    `SELECT * FROM credit_accounts WHERE user_id = $1 FOR UPDATE`,
    [userId]
  )
  if (accountRes.rows.length === 0) {
    throw new BillingError(INSUFFICIENT_CREDITS, `Credit account does not exist for user: ${userId}`)
  }
  let currentAccount = accountRes.rows[0]
  let currentAvailable = toSafeInt(currentAccount.available_credits)
  let currentReserved = toSafeInt(currentAccount.reserved_credits)

  // Check existing charge with lock
  const chargeRes = await client.query<GenerationChargeRow>(
    `SELECT * FROM generation_charges WHERE job_id = $1 FOR UPDATE`,
    [jobId]
  )

  if (chargeRes.rows.length === 0) {
    // First-time reservation: cycle = 1
    const idemKey = input.idempotencyKey || `reserve:${jobId}:1`

    // Check idempotency ledger in case prior attempt recorded ledger
    const existingLedger = await client.query(
      `SELECT * FROM credit_ledger WHERE idempotency_key = $1`,
      [idemKey]
    )
    if (existingLedger.rows.length > 0) {
      // Reload charge
      const reloadedCharge = await client.query<GenerationChargeRow>(
        `SELECT * FROM generation_charges WHERE job_id = $1`,
        [jobId]
      )
      return {
        charge: toGenerationChargeEntity(reloadedCharge.rows[0]),
        account: toCreditAccountEntity(currentAccount),
        alreadyProcessed: true,
      }
    }

    if (currentAvailable < quotedCredits) {
      throw new BillingError(
        INSUFFICIENT_CREDITS,
        `Insufficient credits: available=${currentAvailable}, required=${quotedCredits}`,
        { available: currentAvailable, required: quotedCredits }
      )
    }

    const nextAvailable = currentAvailable - quotedCredits
    const nextReserved = currentReserved + quotedCredits

    // Update account
    const updatedAccountRes = await client.query<CreditAccountRow>(
      `UPDATE credit_accounts
       SET available_credits = $1, reserved_credits = $2, updated_at = now()
       WHERE user_id = $3
       RETURNING *`,
      [nextAvailable, nextReserved, userId]
    )
    currentAccount = updatedAccountRes.rows[0]

    // Create charge
    const newChargeRes = await client.query<GenerationChargeRow>(
      `INSERT INTO generation_charges (
        job_id, user_id, quoted_credits, state, billing_cycle,
        pricing_snapshot, reserved_at
      ) VALUES ($1, $2, $3, 'reserved', 1, $4, now())
      RETURNING *`,
      [jobId, userId, quotedCredits, JSON.stringify(pricingSnapshot)]
    )

    // Write ledger
    await client.query(
      `INSERT INTO credit_ledger (
        user_id, operation, available_delta, reserved_delta,
        available_after, reserved_after, reference_type, reference_id,
        billing_cycle, idempotency_key, note
      ) VALUES ($1, 'reservation', $2, $3, $4, $5, 'generation_job', $6, 1, $7, $8)`,
      [
        userId,
        -quotedCredits,
        quotedCredits,
        nextAvailable,
        nextReserved,
        jobId,
        idemKey,
        `Reservation for job ${jobId} cycle 1`,
      ]
    )

    return {
      charge: toGenerationChargeEntity(newChargeRes.rows[0]),
      account: toCreditAccountEntity(currentAccount),
      alreadyProcessed: false,
    }
  }

  // Charge already exists
  const existingCharge = chargeRes.rows[0]

  if (existingCharge.state === 'reserved') {
    // Already reserved
    return {
      charge: toGenerationChargeEntity(existingCharge),
      account: toCreditAccountEntity(currentAccount),
      alreadyProcessed: true,
    }
  }

  if (existingCharge.state === 'settled') {
    throw new BillingError(
      BILLING_STATE_CONFLICT,
      `Cannot reserve job ${jobId}: charge is already settled`
    )
  }

  if (existingCharge.state === 'released') {
    // Retry flow on released charge: increment cycle, re-freeze according to original quoted_credits / snapshot
    const originalQuoted = toSafeInt(existingCharge.quoted_credits)
    const nextCycle = Number(existingCharge.billing_cycle) + 1
    const idemKey = input.idempotencyKey || `reserve:${jobId}:${nextCycle}`

    // Check if this cycle was already processed
    const existingLedger = await client.query(
      `SELECT * FROM credit_ledger WHERE idempotency_key = $1`,
      [idemKey]
    )
    if (existingLedger.rows.length > 0) {
      const reloadedCharge = await client.query<GenerationChargeRow>(
        `SELECT * FROM generation_charges WHERE job_id = $1`,
        [jobId]
      )
      return {
        charge: toGenerationChargeEntity(reloadedCharge.rows[0]),
        account: toCreditAccountEntity(currentAccount),
        alreadyProcessed: true,
      }
    }

    if (currentAvailable < originalQuoted) {
      throw new BillingError(
        INSUFFICIENT_CREDITS,
        `Insufficient credits for retry: available=${currentAvailable}, required=${originalQuoted}`,
        { available: currentAvailable, required: originalQuoted }
      )
    }

    const nextAvailable = currentAvailable - originalQuoted
    const nextReserved = currentReserved + originalQuoted

    const updatedAccountRes = await client.query<CreditAccountRow>(
      `UPDATE credit_accounts
       SET available_credits = $1, reserved_credits = $2, updated_at = now()
       WHERE user_id = $3
       RETURNING *`,
      [nextAvailable, nextReserved, userId]
    )
    currentAccount = updatedAccountRes.rows[0]

    const updatedChargeRes = await client.query<GenerationChargeRow>(
      `UPDATE generation_charges
       SET state = 'reserved',
           billing_cycle = $1,
           reserved_at = now(),
           released_at = null,
           settled_at = null,
           updated_at = now()
       WHERE job_id = $2
       RETURNING *`,
      [nextCycle, jobId]
    )

    await client.query(
      `INSERT INTO credit_ledger (
        user_id, operation, available_delta, reserved_delta,
        available_after, reserved_after, reference_type, reference_id,
        billing_cycle, idempotency_key, note
      ) VALUES ($1, 'reservation', $2, $3, $4, $5, 'generation_job', $6, $7, $8, $9)`,
      [
        userId,
        -originalQuoted,
        originalQuoted,
        nextAvailable,
        nextReserved,
        jobId,
        nextCycle,
        idemKey,
        `Re-reservation for job ${jobId} cycle ${nextCycle}`,
      ]
    )

    return {
      charge: toGenerationChargeEntity(updatedChargeRes.rows[0]),
      account: toCreditAccountEntity(currentAccount),
      alreadyProcessed: false,
    }
  }

  throw new BillingError(
    BILLING_STATE_CONFLICT,
    `Invalid billing state for job ${jobId}: ${existingCharge.state}`
  )
}

export interface CaptureGenerationCreditsInput {
  jobId: string
  idempotencyKey?: string
  note?: string | null
}

export interface CaptureGenerationCreditsResult {
  charge: GenerationChargeEntity
  account: CreditAccountEntity
  alreadyProcessed: boolean
}

export async function captureGenerationCredits(
  client: pg.PoolClient,
  input: CaptureGenerationCreditsInput
): Promise<CaptureGenerationCreditsResult> {
  const { jobId } = input

  // Lock charge
  const chargeRes = await client.query<GenerationChargeRow>(
    `SELECT * FROM generation_charges WHERE job_id = $1 FOR UPDATE`,
    [jobId]
  )
  if (chargeRes.rows.length === 0) {
    throw new BillingError(BILLING_STATE_CONFLICT, `Charge record not found for job ${jobId}`)
  }
  const charge = chargeRes.rows[0]
  const userId = charge.user_id

  // Lock account
  const accountRes = await client.query<CreditAccountRow>(
    `SELECT * FROM credit_accounts WHERE user_id = $1 FOR UPDATE`,
    [userId]
  )
  if (accountRes.rows.length === 0) {
    throw new BillingError(BILLING_STATE_CONFLICT, `Credit account not found for user ${userId}`)
  }
  let currentAccount = accountRes.rows[0]

  if (charge.state === 'settled') {
    return {
      charge: toGenerationChargeEntity(charge),
      account: toCreditAccountEntity(currentAccount),
      alreadyProcessed: true,
    }
  }

  if (charge.state !== 'reserved') {
    throw new BillingError(
      BILLING_STATE_CONFLICT,
      `Cannot capture charge for job ${jobId}: current state is ${charge.state}`
    )
  }

  const quoted = toSafeInt(charge.quoted_credits)
  const cycle = Number(charge.billing_cycle)
  const currentAvailable = toSafeInt(currentAccount.available_credits)
  const currentReserved = toSafeInt(currentAccount.reserved_credits)

  if (currentReserved < quoted) {
    throw new BillingError(
      BILLING_STATE_CONFLICT,
      `Reserved credits corrupt or insufficient for user ${userId}: reserved=${currentReserved}, needed=${quoted}`
    )
  }

  const nextReserved = currentReserved - quoted
  const idemKey = input.idempotencyKey || `capture:${jobId}:${cycle}`

  // Check ledger idempotency
  const existingLedger = await client.query(
    `SELECT * FROM credit_ledger WHERE idempotency_key = $1`,
    [idemKey]
  )
  if (existingLedger.rows.length > 0) {
    return {
      charge: toGenerationChargeEntity(charge),
      account: toCreditAccountEntity(currentAccount),
      alreadyProcessed: true,
    }
  }

  // Update account (reserved decreases, available untouched)
  const updatedAccountRes = await client.query<CreditAccountRow>(
    `UPDATE credit_accounts
     SET reserved_credits = $1, updated_at = now()
     WHERE user_id = $2
     RETURNING *`,
    [nextReserved, userId]
  )
  currentAccount = updatedAccountRes.rows[0]

  // Update charge to settled
  const updatedChargeRes = await client.query<GenerationChargeRow>(
    `UPDATE generation_charges
     SET state = 'settled', settled_at = now(), updated_at = now()
     WHERE job_id = $1
     RETURNING *`,
    [jobId]
  )

  // Append ledger
  await client.query(
    `INSERT INTO credit_ledger (
      user_id, operation, available_delta, reserved_delta,
      available_after, reserved_after, reference_type, reference_id,
      billing_cycle, idempotency_key, note
    ) VALUES ($1, 'capture', 0, $2, $3, $4, 'generation_job', $5, $6, $7, $8)`,
    [
      userId,
      -quoted,
      currentAvailable,
      nextReserved,
      jobId,
      cycle,
      idemKey,
      input.note || `Capture for job ${jobId} cycle ${cycle}`,
    ]
  )

  return {
    charge: toGenerationChargeEntity(updatedChargeRes.rows[0]),
    account: toCreditAccountEntity(currentAccount),
    alreadyProcessed: false,
  }
}

export interface ReleaseGenerationCreditsInput {
  jobId: string
  idempotencyKey?: string
  note?: string | null
}

export interface ReleaseGenerationCreditsResult {
  charge: GenerationChargeEntity
  account: CreditAccountEntity
  alreadyProcessed: boolean
}

export async function releaseGenerationCredits(
  client: pg.PoolClient,
  input: ReleaseGenerationCreditsInput
): Promise<ReleaseGenerationCreditsResult> {
  const { jobId } = input

  // Lock charge
  const chargeRes = await client.query<GenerationChargeRow>(
    `SELECT * FROM generation_charges WHERE job_id = $1 FOR UPDATE`,
    [jobId]
  )
  if (chargeRes.rows.length === 0) {
    throw new BillingError(BILLING_STATE_CONFLICT, `Charge record not found for job ${jobId}`)
  }
  const charge = chargeRes.rows[0]
  const userId = charge.user_id

  // Lock account
  const accountRes = await client.query<CreditAccountRow>(
    `SELECT * FROM credit_accounts WHERE user_id = $1 FOR UPDATE`,
    [userId]
  )
  if (accountRes.rows.length === 0) {
    throw new BillingError(BILLING_STATE_CONFLICT, `Credit account not found for user ${userId}`)
  }
  let currentAccount = accountRes.rows[0]

  if (charge.state === 'released') {
    return {
      charge: toGenerationChargeEntity(charge),
      account: toCreditAccountEntity(currentAccount),
      alreadyProcessed: true,
    }
  }

  if (charge.state !== 'reserved') {
    throw new BillingError(
      BILLING_STATE_CONFLICT,
      `Cannot release charge for job ${jobId}: current state is ${charge.state}`
    )
  }

  const quoted = toSafeInt(charge.quoted_credits)
  const cycle = Number(charge.billing_cycle)
  const currentAvailable = toSafeInt(currentAccount.available_credits)
  const currentReserved = toSafeInt(currentAccount.reserved_credits)

  if (currentReserved < quoted) {
    throw new BillingError(
      BILLING_STATE_CONFLICT,
      `Reserved credits corrupt or insufficient for user ${userId}: reserved=${currentReserved}, needed=${quoted}`
    )
  }

  const nextAvailable = currentAvailable + quoted
  const nextReserved = currentReserved - quoted
  const idemKey = input.idempotencyKey || `release:${jobId}:${cycle}`

  // Check ledger idempotency
  const existingLedger = await client.query(
    `SELECT * FROM credit_ledger WHERE idempotency_key = $1`,
    [idemKey]
  )
  if (existingLedger.rows.length > 0) {
    return {
      charge: toGenerationChargeEntity(charge),
      account: toCreditAccountEntity(currentAccount),
      alreadyProcessed: true,
    }
  }

  // Update account (available increases, reserved decreases)
  const updatedAccountRes = await client.query<CreditAccountRow>(
    `UPDATE credit_accounts
     SET available_credits = $1, reserved_credits = $2, updated_at = now()
     WHERE user_id = $3
     RETURNING *`,
    [nextAvailable, nextReserved, userId]
  )
  currentAccount = updatedAccountRes.rows[0]

  // Update charge to released
  const updatedChargeRes = await client.query<GenerationChargeRow>(
    `UPDATE generation_charges
     SET state = 'released', released_at = now(), updated_at = now()
     WHERE job_id = $1
     RETURNING *`,
    [jobId]
  )

  // Append ledger
  await client.query(
    `INSERT INTO credit_ledger (
      user_id, operation, available_delta, reserved_delta,
      available_after, reserved_after, reference_type, reference_id,
      billing_cycle, idempotency_key, note
    ) VALUES ($1, 'release', $2, $3, $4, $5, 'generation_job', $6, $7, $8, $9)`,
    [
      userId,
      quoted,
      -quoted,
      nextAvailable,
      nextReserved,
      jobId,
      cycle,
      idemKey,
      input.note || `Release for job ${jobId} cycle ${cycle}`,
    ]
  )

  return {
    charge: toGenerationChargeEntity(updatedChargeRes.rows[0]),
    account: toCreditAccountEntity(currentAccount),
    alreadyProcessed: false,
  }
}

export interface AdjustCreditsInput {
  userId: string
  amount: number
  idempotencyKey: string
  createdBy?: string | null
  note?: string | null
  referenceType?: string | null
  referenceId?: string | null
}

export interface AdjustCreditsResult {
  account: CreditAccountEntity
  alreadyProcessed: boolean
}

export async function adjustCredits(
  client: pg.PoolClient,
  input: AdjustCreditsInput
): Promise<AdjustCreditsResult> {
  const { userId, amount, idempotencyKey } = input

  if (!Number.isSafeInteger(amount) || amount === 0) {
    throw new BillingError(INVALID_CREDIT_AMOUNT, `Adjustment amount must be a non-zero safe integer: ${amount}`)
  }

  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new BillingError(INVALID_CREDIT_AMOUNT, `idempotencyKey is required for adjustCredits`)
  }

  // Lock account
  const accountRes = await client.query<CreditAccountRow>(
    `SELECT * FROM credit_accounts WHERE user_id = $1 FOR UPDATE`,
    [userId]
  )
  if (accountRes.rows.length === 0) {
    throw new BillingError(BILLING_STATE_CONFLICT, `Credit account not found for user ${userId}`)
  }
  let currentAccount = accountRes.rows[0]

  // Check idempotency ledger
  const existingLedger = await client.query<CreditLedgerRow>(
    `SELECT * FROM credit_ledger WHERE idempotency_key = $1`,
    [idempotencyKey]
  )
  if (existingLedger.rows.length > 0) {
    const existing = existingLedger.rows[0]
    const existingAvailDelta = toSafeInt(existing.available_delta)
    const existingResDelta = toSafeInt(existing.reserved_delta)
    if (
      existing.operation !== 'adjustment' ||
      existing.user_id !== userId ||
      existingAvailDelta !== amount ||
      existingResDelta !== 0
    ) {
      throw new BillingError(
        BILLING_STATE_CONFLICT,
        `Idempotency conflict: key ${idempotencyKey} already used with mismatched parameters`
      )
    }
    return {
      account: toCreditAccountEntity(currentAccount),
      alreadyProcessed: true,
    }
  }

  const currentAvailable = toSafeInt(currentAccount.available_credits)
  const currentReserved = toSafeInt(currentAccount.reserved_credits)
  const nextAvailable = currentAvailable + amount

  if (!Number.isSafeInteger(nextAvailable)) {
    throw new BillingError(INVALID_CREDIT_AMOUNT, `Adjusted balance exceeds safe integer range: ${nextAvailable}`)
  }

  if (nextAvailable < 0) {
    throw new BillingError(
      INSUFFICIENT_CREDITS,
      `Insufficient credits for adjustment: available=${currentAvailable}, adjustment=${amount}`,
      { available: currentAvailable, adjustment: amount }
    )
  }

  const updatedAccountRes = await client.query<CreditAccountRow>(
    `UPDATE credit_accounts
     SET available_credits = $1, updated_at = now()
     WHERE user_id = $2
     RETURNING *`,
    [nextAvailable, userId]
  )
  currentAccount = updatedAccountRes.rows[0]

  const operation: CreditLedgerOperation = 'adjustment'

  await client.query(
    `INSERT INTO credit_ledger (
      user_id, operation, available_delta, reserved_delta,
      available_after, reserved_after, reference_type, reference_id,
      idempotency_key, created_by, note
    ) VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, $10)`,
    [
      userId,
      operation,
      amount,
      nextAvailable,
      currentReserved,
      input.referenceType ?? 'manual_adjustment',
      input.referenceId ?? null,
      idempotencyKey,
      input.createdBy ?? null,
      input.note ?? `Manual adjustment of ${amount} credits`,
    ]
  )

  return {
    account: toCreditAccountEntity(currentAccount),
    alreadyProcessed: false,
  }
}
