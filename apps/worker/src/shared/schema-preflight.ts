import { db } from '@musecanvas/database'

export const REQUIRED_WORKER_OUTBOX_COLUMNS = ['event_type', 'dispatch_token', 'dispatch_lease_expires_at', 'quarantined_at', 'quarantine_code'] as const

/** Control-plane relations and columns read or written by the Agent recovery coordinator. */
export const REQUIRED_AGENT_COLUMNS = [
  ['agent_turns', 'cancel_requested_at'],
  ['agent_turns', 'deadline_at'],
  ['agent_turns', 'lease_until'],
  ['agent_turns', 'revision'],
  ['agent_turns', 'status'],
  ['agent_approvals', 'decision_revision'],
  ['agent_approvals', 'expires_at'],
  ['agent_approvals', 'status'],
  ['agent_approvals', 'tool_call_id'],
  ['agent_budget_reservations', 'status'],
  ['agent_budget_reservations', 'quota'],
  ['agent_budget_reservations', 'tool_call_id'],
  ['agent_budget_reservations', 'settled_at'],
  ['agent_sessions', 'active_turn_id'],
  ['agent_sessions', 'next_event_cursor'],
  ['agent_sessions', 'event_retention_floor'],
  ['agent_session_events', 'cursor'],
  ['agent_session_events', 'event_type'],
  ['agent_session_events', 'payload'],
  ['agent_tool_job_links', 'tool_call_id'],
  ['agent_tool_job_links', 'media_job_id'],
  ['outbox_events', 'quarantined_at'],
  ['outbox_events', 'dedupe_key'],
  ['outbox_events', 'event_type'],
] as const

export const REQUIRED_AGENT_COLUMN_KEYS = REQUIRED_AGENT_COLUMNS.map(([table, column]) => `${table}.${column}`)
export const REQUIRED_AGENT_MEDIA_COLUMNS = ['upload_id', 'owner_id', 'source_checksum', 'mask_checksum', 'width', 'height', 'preparation_version', 'expires_at'] as const

/** Recovery indexes added by migration 0044; the coordinator scans require all four. */
export const REQUIRED_AGENT_RECOVERY_INDEXES = [
  'agent_turns_deadline_recovery_idx',
  'agent_turns_cancel_recovery_idx',
  'agent_tool_calls_waiting_external_idx',
  'outbox_events_quarantine_idx',
] as const

export class WorkerAgentIndexSchemaRequiredError extends Error {
  constructor(readonly missingIndexes: readonly string[]) {
    super('Worker requires migration 0044: Agent recovery indexes must exist before startup')
    this.name = 'WORKER_SCHEMA_0044_INDEX_REQUIRED'
  }
}

export class WorkerAgentMediaSchemaRequiredError extends Error {
  constructor(readonly missingColumns: readonly string[]) {
    super('Worker requires migration 0045: trusted Agent mask preparation identity must exist before startup')
    this.name = 'WORKER_SCHEMA_0045_REQUIRED'
  }
}

const REQUIRED_AGENT_COLUMNS_SQL = REQUIRED_AGENT_COLUMNS.map(([table, column]) => `('${table}','${column}')`).join(', ')

const MISSING_AGENT_COLUMNS_SQL = `SELECT expected.table_name || '.' || expected.column_name AS missing_column
  FROM (VALUES ${REQUIRED_AGENT_COLUMNS_SQL}) AS expected(table_name, column_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=pg_catalog.to_regclass(expected.table_name)
      AND a.attname=expected.column_name AND a.attnum>0 AND NOT a.attisdropped
  )
  ORDER BY 1`

const REQUIRED_AGENT_RECOVERY_INDEXES_SQL = REQUIRED_AGENT_RECOVERY_INDEXES.map(name => `('${name}')`).join(', ')

const MISSING_AGENT_RECOVERY_INDEXES_SQL = `SELECT expected.index_name AS missing_index
  FROM (VALUES ${REQUIRED_AGENT_RECOVERY_INDEXES_SQL}) AS expected(index_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes i
    WHERE i.schemaname = ANY (pg_catalog.current_schemas(false))
      AND i.indexname = expected.index_name
  )
  ORDER BY 1`

export class WorkerSchemaRequiredError extends Error {
  constructor(readonly missingColumns: readonly string[]) {
    super('Worker requires migration 0042: outbox dispatch lease and quarantine columns must exist before startup')
    this.name = 'WORKER_SCHEMA_0042_REQUIRED'
  }
}

export class WorkerAgentSchemaRequiredError extends Error {
  constructor(readonly missingColumns: readonly string[]) {
    super('Worker requires migration 0043: Agent control-plane recovery relations and columns must exist before startup')
    this.name = 'WORKER_SCHEMA_0043_REQUIRED'
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

  const agent = await client.query<{ missing_column: string }>(MISSING_AGENT_COLUMNS_SQL)
  const missingAgentColumns = agent.rows
    .map(row => row.missing_column)
    .filter((column): column is string => typeof column === 'string' && column.length > 0)
  if (missingAgentColumns.length > 0) throw new WorkerAgentSchemaRequiredError(missingAgentColumns)

  const preparation = await client.query<{ column_name: string }>(`SELECT a.attname AS column_name
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid=pg_catalog.to_regclass('agent_media_mask_preparations')
      AND a.attnum>0 AND NOT a.attisdropped`)
  const preparationColumns = new Set(preparation.rows.map(row => row.column_name))
  const missingPreparation = REQUIRED_AGENT_MEDIA_COLUMNS.filter(column => !preparationColumns.has(column))
  if (missingPreparation.length) throw new WorkerAgentMediaSchemaRequiredError(
    missingPreparation.map(column => `agent_media_mask_preparations.${column}`))

  const indexes = await client.query<{ missing_index: string }>(MISSING_AGENT_RECOVERY_INDEXES_SQL)
  const missingIndexes = indexes.rows
    .map(row => row.missing_index)
    .filter((index): index is string => typeof index === 'string' && index.length > 0)
  if (missingIndexes.length > 0) throw new WorkerAgentIndexSchemaRequiredError(missingIndexes)
}
