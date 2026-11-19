/**
 * The canonical UUID shape shared by every table id this API accepts in a path
 * or body (`users`, `model_configs`, `generation_jobs`, `assets`, ...). Pure and
 * dependency-free like the rest of the contract helpers, so the browser, the
 * API and the worker can all call it.
 *
 * Path parameters are validated *before* they reach a uuid-typed query
 * parameter: Postgres rejects a malformed literal with `22P02`, and an
 * uncaught cast error surfaces as a 500 instead of a 400.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}
