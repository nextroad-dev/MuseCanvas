/**
 * In-app route literals shared by the workspace shell.
 *
 * `API_ENDPOINTS` in `@musecanvas/contracts` is the single source for *backend*
 * paths; these are the browser-side pages those paths serve, so they live here
 * rather than in the contracts package. `useGenerationMode` and the workspace
 * navigation both need `/generate`, and a literal in each file is how the two
 * would silently disagree.
 */
export const GENERATE_ROUTE = '/generate'

export const LIBRARY_ROUTE = '/library'

export function isOnGenerate(pathname: string): boolean {
  return pathname === GENERATE_ROUTE || pathname.startsWith(`${GENERATE_ROUTE}/`)
}

/**
 * The post-login `?from=` target, reduced to a same-origin path. Anything that
 * could leave the site (`https://…`, protocol-relative `//host`, `/\host`, which
 * browsers normalise to `//host`) falls back to the creation console, so the
 * login page can never be used as an open redirect.
 */
export function safeRedirectPath(from: string | null | undefined): string {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) {
    return GENERATE_ROUTE
  }
  return from
}
