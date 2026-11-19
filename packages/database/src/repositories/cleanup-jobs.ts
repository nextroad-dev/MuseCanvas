import type pg from 'pg'

export type CleanupKind = 'account' | 'asset'
export interface CleanupClaim {
  kind: CleanupKind
  id: string
  token: string
  userId?: string
  assetId?: string
  objectKey?: string
}
export type CleanupWaitCode = 'WAITING_AGENT_SETTLEMENT' | 'WAITING_MEDIA_SETTLEMENT' | 'WAITING_OBJECT_DELETION'
export type CleanupBlockCode = 'BLOCKED_AGENT_RETENTION_POLICY' | 'BLOCKED_AGENT_REFERENCE' | 'BLOCKED_ACCOUNT_STATE'
const tables = { account: 'deletion_jobs', asset: 'asset_deletion_jobs' } as const

export class CleanupLeaseLost extends Error {
  constructor() { super('CLEANUP_LEASE_LOST'); this.name = 'CleanupLeaseLost' }
}

/** All fences use the database clock; storage requests must stay outside withClaim(). */
export class CleanupJobRepository {
  private readonly leaseMs: number
  constructor(private readonly pool: Pick<pg.Pool, 'query' | 'connect'>, leaseMs = 60_000) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 300_000) throw new Error('INVALID_CLEANUP_LEASE')
    this.leaseMs = leaseMs
  }

  async claim(kind: CleanupKind): Promise<CleanupClaim | null> {
    const table = tables[kind]
    const result = await this.pool.query(`WITH ready AS (
      SELECT id FROM ${table} WHERE completed_at IS NULL AND blocked_at IS NULL
        AND next_attempt_at<=clock_timestamp()
        AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
      ORDER BY next_attempt_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE ${table} j SET claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+($1 * interval '1 millisecond')
      FROM ready WHERE j.id=ready.id RETURNING j.*`, [this.leaseMs])
    const row = result.rows[0]
    return row ? { kind, id: String(row.id), token: String(row.claim_token),
      ...(kind === 'account' ? { userId: String(row.user_id) } : { assetId: String(row.asset_id), objectKey: String(row.object_key) }) } : null
  }

  async renew(claim: CleanupClaim): Promise<void> {
    const result = await this.pool.query(`UPDATE ${tables[claim.kind]} SET lease_expires_at=clock_timestamp()+($3 * interval '1 millisecond')
      WHERE id=$1 AND claim_token=$2 AND completed_at IS NULL AND lease_expires_at>clock_timestamp() RETURNING id`,
    [claim.id, claim.token, this.leaseMs])
    if (!result.rows.length) throw new CleanupLeaseLost()
  }

  async release(claim: CleanupClaim, code: CleanupWaitCode | null = null): Promise<void> {
    await this.pool.query(`UPDATE ${tables[claim.kind]} SET claim_token=NULL,lease_expires_at=NULL,
      next_attempt_at=clock_timestamp()+interval '5 seconds',last_error_code=$3
      WHERE id=$1 AND claim_token=$2 AND completed_at IS NULL AND lease_expires_at>clock_timestamp()`,
    [claim.id, claim.token, code])
  }

  async retry(claim: CleanupClaim): Promise<void> {
    await this.pool.query(`UPDATE ${tables[claim.kind]} SET attempts=attempts+1,last_error_code='CLEANUP_FAILED',
      next_attempt_at=clock_timestamp()+((LEAST(3600,5*power(2,LEAST(attempts,10)))+floor(random()*5))*interval '1 second'),
      claim_token=NULL,lease_expires_at=NULL
      WHERE id=$1 AND claim_token=$2 AND completed_at IS NULL AND lease_expires_at>clock_timestamp()`, [claim.id, claim.token])
  }

  async block(claim: CleanupClaim, code: CleanupBlockCode): Promise<void> {
    await this.pool.query(`UPDATE ${tables[claim.kind]} SET blocked_at=clock_timestamp(),last_error_code=$3,claim_token=NULL,lease_expires_at=NULL
      WHERE id=$1 AND claim_token=$2 AND completed_at IS NULL AND lease_expires_at>clock_timestamp()`, [claim.id, claim.token, code])
  }

  /** Short fenced transaction for progress or completion. A fence lost during work rolls it all back. */
  async withClaim<T>(claim: CleanupClaim, work: (client: pg.PoolClient) => Promise<T>, complete = false): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const lock = await client.query(`SELECT id FROM ${tables[claim.kind]} WHERE id=$1 AND claim_token=$2
        AND completed_at IS NULL AND lease_expires_at>clock_timestamp() FOR UPDATE`, [claim.id, claim.token])
      if (!lock.rows.length) throw new CleanupLeaseLost()
      const value = await work(client)
      const fence = await client.query(`UPDATE ${tables[claim.kind]} SET ${complete
        ? 'completed_at=clock_timestamp(),last_error_code=NULL,claim_token=NULL,lease_expires_at=NULL'
        : 'claim_token=claim_token'}
        WHERE id=$1 AND claim_token=$2 AND completed_at IS NULL AND lease_expires_at>clock_timestamp() RETURNING id`, [claim.id, claim.token])
      if (!fence.rows.length) throw new CleanupLeaseLost()
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}
