import type { NextRequest, NextResponse } from 'next/server'
import type { Actor } from '../auth/security'

/**
 * Types for the declarative route table.
 *
 * `access` is deliberately explicit per route rather than derived from the path,
 * because the behaviour being preserved is the *order* of the old handler: an
 * unauthenticated request to anything outside the public prefix answers 401, and
 * an authenticated non-admin hitting an unmatched `admin/` path answers 403,
 * not 404. `dispatch.ts` asserts the two agree.
 */

export type Access = 'public' | 'actor' | 'admin'

export type RouteParams = Record<string, string>

type Common = {
  request: NextRequest
  /** Catch-all remainder, without the leading `/api/`. */
  path: string
  params: RouteParams
  /**
   * Parsed JSON body, memoized. Lazy so a multipart route can never consume the
   * request stream by accident: `body()` is JSON-only and was previously read
   * unconditionally in POST, with the plugin upload paths hoisted above it.
   */
  json: () => Promise<Record<string, unknown>>
}

export type PublicContext = Common & { actor: undefined }
export type AuthedContext = Common & { actor: Actor }
export type HandlerContext = PublicContext | AuthedContext

export type HandlerResult = NextResponse | Promise<NextResponse>
export type Handler = (context: HandlerContext) => HandlerResult

export type Route =
  | { path: string; access: 'public'; handler: (context: PublicContext) => HandlerResult }
  | { path: string; access: 'actor' | 'admin'; handler: (context: AuthedContext) => HandlerResult }

export type MatchedRoute = { route: Route; params: RouteParams }

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
