import { body, fail, mutationOriginValid } from '../shared/http'
import type { NextRequest, NextResponse } from 'next/server'
import { isResponse, requireActor } from './guard'
import { matchRoute } from './match'
import { DELETE_ROUTES, GET_ROUTES, PATCH_ROUTES, POST_ROUTES } from './routes'
import type { Route } from './types'

/**
 * The dispatcher: one ordered route table and one pipeline per method.
 *
 * Table order is precedence, and `access` is declared per route. That is safe
 * because `router.test.ts` asserts the invariant the old inline handler relied
 * on — a path is administratively gated exactly when it begins with `admin/`.
 *
 * The part worth understanding is the *fallthrough*. The old code ran one global
 * gate before any protected route and only then reached its `404`, so an
 * unmatched `admin/...` path answered 403 to a signed-in non-admin and 404 to an
 * admin. Reproducing that means the no-match path has to run the same gate
 * rather than answering 404 directly.
 */

export const notFound = () => fail('NOT_FOUND', '接口不存在', 404)

type Context = {
  request: NextRequest
  path: string
  params: Record<string, string>
  json: () => Promise<Record<string, unknown>>
}

function makeContext(request: NextRequest, path: string, params: Record<string, string>): Context {
  let parsed: Record<string, unknown> | undefined
  // Lazy and memoized: `body()` is JSON-only and consumes the stream, so a
  // multipart route must be able to answer without ever triggering it.
  return { request, path, params, json: async () => (parsed ??= await body(request)) }
}

async function answer(route: Route, context: Context): Promise<NextResponse> {
  if (route.access === 'public') {
    return route.handler({ ...context, actor: undefined })
  }
  const actor = await requireActor(context.request, route.access === 'admin')
  if (isResponse(actor)) return actor
  return route.handler({ ...context, actor })
}

/** The gate the old handler applied before its trailing 404. */
async function unmatchedGate(request: NextRequest, path: string, alwaysAdmin: boolean) {
  const actor = await requireActor(request, alwaysAdmin || path.startsWith('admin/'))
  return isResponse(actor) ? actor : null
}

export async function dispatchGet(request: NextRequest, path: string) {
  const matched = matchRoute(GET_ROUTES, path)
  if (matched) return answer(matched.route, makeContext(request, path, matched.params))
  return (await unmatchedGate(request, path, false)) ?? notFound()
}

export async function dispatchPost(request: NextRequest, path: string) {
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403)
  const matched = matchRoute(POST_ROUTES, path)
  if (matched) return answer(matched.route, makeContext(request, path, matched.params))
  return (await unmatchedGate(request, path, false)) ?? notFound()
}

export async function dispatchPatch(request: NextRequest, path: string) {
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403)
  const matched = matchRoute(PATCH_ROUTES, path)
  if (matched) return answer(matched.route, makeContext(request, path, matched.params))
  // Every PATCH route is administrative, and so is the 404 for an unknown one.
  return (await unmatchedGate(request, path, true)) ?? notFound()
}

/**
 * PUT is accepted but never handled: it exists so a PUT still passes the admin
 * gate before 404ing. The 401 and 403 for an unauthorized PUT are observable.
 */
export async function dispatchPut(request: NextRequest, path: string) {
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403)
  return (await unmatchedGate(request, path, true)) ?? notFound()
}

export async function dispatchDelete(request: NextRequest, path: string) {
  if (!mutationOriginValid(request)) return fail('CSRF_REJECTED', '请求来源无效', 403)
  const matched = matchRoute(DELETE_ROUTES, path)
  if (matched) return answer(matched.route, makeContext(request, path, matched.params))
  return (await unmatchedGate(request, path, false)) ?? notFound()
}
