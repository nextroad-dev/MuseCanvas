// Delivery channel for the one-time setup claim code. Pure: the caller passes the
// environment block, so the mode choice is unit-testable and nothing is read implicitly.
// The plaintext code is never stored and is never returned by an API response.

export const SETUP_CLAIM_DELIVERY_MODES = ['file', 'log', 'off'] as const

export type ClaimDelivery =
  /** Plaintext written to `file` with mode 0600. Nothing reaches stdout. */
  | { mode: 'file'; file: string }
  /** One delimited block on stdout, printed once per newly installed claim. */
  | { mode: 'log' }
  /** Nothing is minted. `problem` is set when the configuration is wrong, not merely off. */
  | { mode: 'off'; problem?: string }

/**
 * Chooses how a newly minted claim code is delivered.
 *
 * - `SETUP_CLAIM_DELIVERY=file|log|off` selects the mode explicitly, in any environment.
 * - Unset: `file` when `SETUP_CLAIM_FILE` is set; otherwise `log` outside production;
 *   otherwise `off`, because production has no channel that keeps the plaintext out of logs.
 * - `file` without `SETUP_CLAIM_FILE`, and any unknown value, mint nothing and report a problem.
 */
export function resolveClaimDelivery(env: Record<string, string | undefined>): ClaimDelivery {
  const claimFile = env.SETUP_CLAIM_FILE?.trim() || null
  const raw = env.SETUP_CLAIM_DELIVERY?.trim().toLowerCase() || null
  if (raw !== null && !(SETUP_CLAIM_DELIVERY_MODES as readonly string[]).includes(raw)) {
    return { mode: 'off', problem: 'SETUP_CLAIM_DELIVERY must be file, log or off; no setup claim was minted' }
  }
  if (raw === null) {
    if (claimFile) return { mode: 'file', file: claimFile }
    if (env.NODE_ENV !== 'production') return { mode: 'log' }
    return {
      mode: 'off',
      problem: 'SETUP_CLAIM_FILE is not configured and SETUP_CLAIM_DELIVERY is unset in production; refusing to mint a setup claim code whose plaintext cannot be delivered without logging it',
    }
  }
  if (raw === 'file') {
    if (claimFile) return { mode: 'file', file: claimFile }
    return { mode: 'off', problem: 'SETUP_CLAIM_DELIVERY=file requires SETUP_CLAIM_FILE; no setup claim was minted' }
  }
  if (raw === 'log') return { mode: 'log' }
  return { mode: 'off' }
}

export interface ClaimLogBlockInput {
  code: string
  expiresAt: string
  ttlMinutes: number
  maxAttempts: number
}

/** The stdout block for `log` mode. Three lines: a rule, the claim line, a rule. */
export function formatClaimLogBlock(input: ClaimLogBlockInput): string {
  const rule = '='.repeat(72)
  return [
    rule,
    `[MUSECANVAS SETUP CLAIM] code=${input.code} expires=${input.expiresAt} (single use, ${input.ttlMinutes} minutes, ${input.maxAttempts} attempts; delete this log line after use)`,
    rule,
  ].join('\n')
}
