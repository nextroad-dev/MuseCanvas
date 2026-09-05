import { hashTokenCandidates } from './security'

export interface InvitationLookupClient {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Array<{ id: string; code_hash: string }> }>
}

/**
 * Finds an active invitation using every accepted token hash and returns the
 * exact stored hash so a later transactional consume can match the same row.
 */
export async function findActiveInvitationHash(
  client: InvitationLookupClient,
  invitationCode: string,
): Promise<string | null> {
  const candidates = hashTokenCandidates(invitationCode.trim())
  const result = await client.query(
    `SELECT id, code_hash
     FROM invitations
     WHERE code_hash = ANY($1)
       AND consumed_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > now()`,
    [candidates],
  )
  const storedHash = result.rows[0]?.code_hash
  return typeof storedHash === 'string' && storedHash.length > 0 ? storedHash : null
}
