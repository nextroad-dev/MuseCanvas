/**
 * Shared URL / host guards for provider egress policy.
 *
 * One private-address definition so the plugin scanner, apps/api and apps/worker all
 * enforce the same SSRF rule. Pure: no node builtins, no I/O.
 */

/** Private / loopback / link-local host test (moved verbatim from language-model.ts). */
export function isPrivateProviderHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '0.0.0.0' || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
}

/** Hostname of an absolute URL, or null when the value is not parseable. Never throws. */
export function urlHostOf(value: string): string | null {
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}
