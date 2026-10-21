// Whether /setup needs the one-time claim code. Pure: the caller passes the environment block.
// Fail safe: only the exact value 'false' (case-insensitive, trimmed) turns the claim off.
// Unset, empty, 'true' and any unrecognised value keep today's required behaviour.

export function resolveClaimRequired(env: Record<string, string | undefined>): boolean {
  return env.SETUP_CLAIM_REQUIRED?.trim().toLowerCase() !== 'false'
}
