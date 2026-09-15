type Queryable = { query: (sql: string, params: unknown[]) => Promise<unknown> }

export async function writeAudit(
  client: Queryable,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  summary: object = {},
): Promise<void> {
  await client.query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,$2,$3,$4,$5)', [actorId, action, targetType, targetId, summary])
}
