import type pg from 'pg'

/** Runs inside the account-deletion transaction, before it is marked complete.
 * Scrub documents (including already soft-deleted ones) and delete historical
 * CanvasAgent content after runtime retirement. Preserve this privacy cleanup
 * while its legacy tables/data remain; it is not an active Agent runtime.
 * No network/storage calls belong in this short transaction.
 */
export async function purgeCanvasContentForActor(client: Pick<pg.PoolClient, 'query'>, actorId: string): Promise<void> {
  await client.query(
    `UPDATE canvas_documents SET deleted_at = COALESCE(deleted_at, now()),
      title = '', scene = '{"nodes":[],"edges":[]}'::jsonb, cover_asset_id = NULL,
      updated_at = now() WHERE created_by = $1`,
    [actorId],
  )
  // M1 can be deployed before migration 0031. Probe before issuing SQL against
  // optional tables; catching undefined_table would leave this transaction aborted.
  const schema = await client.query("SELECT to_regclass('canvas_agent_sessions') AS agent_table")
  if (!schema.rows[0]?.agent_table) return
  // Child-first order respects session/turn foreign keys and removes all prompt,
  // tool-result, scene-operation and pending-generation payload copies.
  for (const table of ['canvas_agent_terminal_events', 'canvas_agent_messages', 'canvas_agent_pending_jobs', 'canvas_agent_turns']) {
    await client.query(
      `DELETE FROM ${table} child USING canvas_agent_sessions session
       WHERE child.session_id = session.id AND session.created_by = $1`,
      [actorId],
    )
  }
  await client.query('DELETE FROM canvas_agent_sessions WHERE created_by = $1', [actorId])
}
