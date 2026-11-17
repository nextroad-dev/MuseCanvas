import { db } from '@musecanvas/database'

export const REQUIRED_WORKER_OUTBOX_COLUMNS = ['event_type', 'dispatch_token', 'dispatch_lease_expires_at', 'quarantined_at', 'quarantine_code'] as const

export class WorkerSchemaRequiredError extends Error {
  constructor(readonly missingColumns: readonly string[]) {
    super('Worker requires migration 0042: outbox dispatch lease and quarantine columns must exist before startup')
    this.name = 'WORKER_SCHEMA_0042_REQUIRED'
  }
}

/** Check the actual relation resolved by dispatch SQL before connecting Redis or serving health. */
export async function assertWorkerSchema(client: Pick<ReturnType<typeof db>, 'query'> = db()): Promise<void> {
  const result = await client.query<{ column_name: string }>(
    `SELECT attname AS column_name FROM pg_catalog.pg_attribute
      WHERE attrelid=pg_catalog.to_regclass('outbox_events') AND attnum>0 AND NOT attisdropped`,
  )
  const columns = new Set(result.rows.map(row => row.column_name))
  const missing = REQUIRED_WORKER_OUTBOX_COLUMNS.filter(column => !columns.has(column))
  if (missing.length > 0) throw new WorkerSchemaRequiredError(missing)
}
