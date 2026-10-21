import assert from 'node:assert/strict'
import test from 'node:test'
import type { NextRequest } from 'next/server'

import { API_ENDPOINTS } from '@musecanvas/contracts'
import { DELETE_ROUTES, GET_ROUTES, PATCH_ROUTES, POST_ROUTES } from './routes'
import { dispatchDelete, dispatchGet, dispatchPatch, dispatchPost, dispatchPut } from './pipeline'
import { matchPath, matchRoute } from './match'
import { mutationOriginValid } from '../shared/http'
import type { Route } from './types'

/**
 * Regression gates for the route table.
 *
 * These exist because the routing behaviour that matters is not "does a path
 * resolve" but the *consequences of the order things resolve in*: who is refused
 * before the 404, which segment wins, and how wide a matcher is. All of that used
 * to be implicit in the fall-through chain of one big handler.
 */

const ALL_TABLES: Array<[string, Route[]]> = [
  ['GET', GET_ROUTES],
  ['POST', POST_ROUTES],
  ['PATCH', PATCH_ROUTES],
  ['DELETE', DELETE_ROUTES],
]

const SAMPLE_UUID = '123e4567-e89b-12d3-a456-426614174000'

/** A pattern is only comparable to a declared URL once its parameters are filled. */
function concrete(path: string): string {
  return path
    .replaceAll(':turnId', SAMPLE_UUID)
    .replaceAll(':hexid', SAMPLE_UUID)
    .replaceAll(':id', SAMPLE_UUID)
    .replaceAll(':oauth', 'github')
}

/**
 * A declared endpoint may be produced by a helper taking either a resource id or
 * an oauth provider name, so one endpoint can have several legitimate concrete
 * spellings.
 */
function declaredCandidates(value: (argument: string, second?: string) => string): string[] {
  return [value(SAMPLE_UUID, SAMPLE_UUID), ...['github', 'google'].map(provider => value(provider, SAMPLE_UUID))]
}

/** Every URL the registry declares, as its possible concrete paths. */
function declaredEndpoints(): Array<{ endpoint: string; candidates: string[] }> {
  const found: Array<{ endpoint: string; candidates: string[] }> = []
  const visit = (node: unknown) => {
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'string') found.push({ endpoint: value, candidates: [value] })
      else if (typeof value === 'function') {
        const candidates = declaredCandidates(value as (argument: string) => string)
        found.push({ endpoint: candidates[0], candidates })
      } else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(API_ENDPOINTS)
  return found
}

const ALL_ROUTES = ALL_TABLES.flatMap(([, routes]) => routes)

/**
 * Endpoints the registry declares but no route serves yet. Listing them keeps the
 * gap visible and falsifiable: the assertion below fails if a path is routed while
 * still listed here, so this cannot quietly accumulate. A new entry needs a reason,
 * not just an unfinished feature.
 */
const DECLARED_WITHOUT_HANDLER: string[] = []

test('every endpoint declared in contracts has a handler', () => {
  const unrouted = declaredEndpoints()
    .filter(({ candidates }) => !candidates.some(candidate => matchRoute(ALL_ROUTES, candidate.replace(/^\/api\//, '')) !== null))
    .map(({ endpoint }) => endpoint)
    .filter(endpoint => !DECLARED_WITHOUT_HANDLER.includes(endpoint))
  assert.deepEqual(unrouted, [], 'API_ENDPOINTS declares paths with no backend handler')
})

test('the declared-but-unrouted list never goes stale', () => {
  for (const endpoint of DECLARED_WITHOUT_HANDLER) {
    const path = endpoint.replace(/^\/api\//, '')
    assert.equal(
      matchRoute(ALL_ROUTES, path) === null,
      true,
      `${endpoint} now has a handler — remove it from DECLARED_WITHOUT_HANDLER`,
    )
  }
})

test('every handler is reachable through a declared endpoint', () => {
  const declared = new Set(declaredEndpoints().flatMap(entry => entry.candidates))
  for (const [method, routes] of ALL_TABLES) {
    for (const route of routes) {
      assert.ok(
        declared.has(`/api/${concrete(route.path)}`),
        `${method} ${route.path} is not declared in API_ENDPOINTS`,
      )
    }
  }
})

test('a path is administratively gated exactly when it begins with admin/', () => {
  // This invariant is what makes per-route `access` equivalent to the old global
  // `requireActor(request, path.startsWith('admin/'))`, including for paths that
  // match nothing at all.
  for (const [method, routes] of ALL_TABLES) {
    for (const route of routes) {
      const isAdmin = route.path.startsWith('admin/')
      assert.equal(route.access === 'admin', isAdmin, `${method} ${route.path}: access=${route.access} but admin-prefix=${isAdmin}`)
    }
  }
})

test('no two routes in one table share a pattern', () => {
  for (const [method, routes] of ALL_TABLES) {
    const seen = new Set<string>()
    for (const route of routes) {
      assert.equal(seen.has(route.path), false, `${method} registers ${route.path} twice`)
      seen.add(route.path)
    }
  }
})

test('order-of-registration precedence is preserved from the inline handler', () => {
  const index = (routes: Route[], path: string) => {
    const found = routes.findIndex(route => route.path === path)
    assert.ok(found >= 0, `no route with pattern ${path}`)
    return found
  }
  // A literal collection must beat the parameterized child, or the list endpoint
  // becomes unreachable.
  assert.ok(index(GET_ROUTES, 'library') < index(GET_ROUTES, 'library/:id/download'))
  assert.ok(index(GET_ROUTES, 'admin/prompt-templates') < index(GET_ROUTES, 'admin/prompt-templates/sets'))
  assert.ok(index(GET_ROUTES, 'admin/prompt-templates/sets') < index(GET_ROUTES, 'admin/prompt-templates/sets/:hexid'))
  assert.ok(index(GET_ROUTES, 'admin/prompt-templates/export') < index(GET_ROUTES, 'admin/prompt-templates/sets/:hexid'))
  assert.ok(index(GET_ROUTES, 'admin/plugins') < index(GET_ROUTES, 'admin/models'))
  // Public and wizard paths precede the session gate, which precedes the rest.
  assert.ok(index(GET_ROUTES, 'registration') < index(GET_ROUTES, 'session'))
  assert.ok(index(GET_ROUTES, 'auth/oauth/providers') < index(GET_ROUTES, 'jobs'))
  assert.ok(index(POST_ROUTES, 'setup/complete') < index(POST_ROUTES, 'auth/otp/request'))
  assert.ok(index(POST_ROUTES, 'auth/logout') < index(POST_ROUTES, 'generations'))
  // The alias and the bare form of the user status route must both resolve.
  assert.ok(index(PATCH_ROUTES, 'admin/users/:id/status') < index(PATCH_ROUTES, 'admin/users/:id'))
})

test('parameter widths still accept and reject what the old regexes did', () => {
  // Each case is [pattern, path, matchedBefore]. The patterns replace specific
  // literals in the old handler; these are the exact acceptance sets.
  const cases: Array<[string, string, boolean]> = [
    ['jobs/:id', `jobs/${SAMPLE_UUID}`, true],
    // The old `/^jobs\/([0-9a-f-]+)$/` accepted a non-v4, even non-hex shape.
    ['jobs/:id', 'jobs/zzz', false],
    ['jobs/:id', 'jobs/deadbeef', true],
    ['jobs/:id', 'jobs/123e4567-e89b-12d3-a456-426614174000/extra', false],
    ['jobs/:id', 'jobs/', false],
    // Prompt template and plugin ids were case-insensitive hex; jobs were not.
    ['admin/prompt-templates/sets/:hexid', 'admin/prompt-templates/sets/ABCDEF', true],
    ['admin/prompt-templates/sets/:hexid', 'admin/prompt-templates/sets/zzzz', false],
    ['admin/plugins/:hexid', 'admin/plugins/upload', false],
    ['admin/plugins/:hexid', 'admin/plugins/validate', false],
    // The oauth enum was spelled out inline and must not widen to any provider.
    ['auth/oauth/:oauth/start', 'auth/oauth/github/start', true],
    ['auth/oauth/:oauth/start', 'auth/oauth/facebook/start', false],
    // PATCH used `(?:/status)?`, so both forms matched one regex; two patterns
    // must cover exactly the same pair and nothing else.
    ['admin/users/:id', `admin/users/${SAMPLE_UUID}`, true],
    ['admin/users/:id', `admin/users/${SAMPLE_UUID}/status`, false],
    ['admin/users/:id/status', `admin/users/${SAMPLE_UUID}/status`, true],
    ['admin/users/:id/status', `admin/users/${SAMPLE_UUID}/status/extra`, false],
  ]
  for (const [pattern, path, expected] of cases) {
    assert.equal(matchPath(pattern, path) !== null, expected, `matchPath('${pattern}', '${path}')`)
  }
})

/**
 * A minimal stand-in: the gate under test only reads headers and cookies.
 *
 * `host` is always present because `mutationOriginValid` compares the Origin
 * against `x-forwarded-host` then `host`; without it every write would be
 * rejected as CSRF and the session gate would never be reached. nginx sets both.
 */
function fakeRequest(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: new Headers({ host: 'musecanvas.test', ...headers }),
    cookies: { get: () => undefined },
    nextUrl: new URL('http://musecanvas.test/api/x'),
  } as unknown as NextRequest
}

async function statusAndCode(response: Response): Promise<[number, string]> {
  const payload = await response.json() as { success: boolean; error?: { code: string } }
  assert.equal(payload.success, false, 'a refused request must keep the {success:false,error} envelope')
  return [response.status, payload.error?.code ?? '']
}

test('an anonymous request is refused with 401 before any 404', async () => {
  // This is the fallthrough behaviour: the old handler ran its global gate ahead
  // of the trailing `NOT_FOUND`, so a typo while signed out never looked like a
  // missing route.
  const cases: Array<[string, Promise<Response>]> = [
    ['GET unknown', dispatchGet(fakeRequest(), 'does/not/exist')],
    ['GET admin typo', dispatchGet(fakeRequest(), 'admin/does-not-exist')],
    ['POST unknown', dispatchPost(fakeRequest({ origin: 'http://musecanvas.test' }), 'does/not/exist')],
    ['PATCH unknown', dispatchPatch(fakeRequest({ origin: 'http://musecanvas.test' }), 'does/not/exist')],
    ['PUT anything', dispatchPut(fakeRequest({ origin: 'http://musecanvas.test' }), 'anything')],
    ['DELETE unknown', dispatchDelete(fakeRequest({ origin: 'http://musecanvas.test' }), 'does/not/exist')],
    // Protected but real paths must not leak their existence to an anonymous caller.
    ['GET admin/users', dispatchGet(fakeRequest(), 'admin/users')],
    ['GET jobs', dispatchGet(fakeRequest(), 'jobs')],
  ]
  for (const [label, pending] of cases) {
    const [status, code] = await statusAndCode(await pending)
    assert.equal(status, 401, label)
    assert.equal(code, 'UNAUTHORIZED', label)
  }
})

test('mutation origin is checked before authentication on every write', async () => {
  // Order matters: a cross-origin request is rejected as CSRF even when the
  // caller would also have failed the session gate.
  const foreign = { origin: 'http://evil.test' }
  const cases: Array<[string, Promise<Response>]> = [
    ['POST', dispatchPost(fakeRequest(foreign), 'auth/otp/request')],
    ['PATCH', dispatchPatch(fakeRequest(foreign), 'admin/users/1')],
    ['PUT', dispatchPut(fakeRequest(foreign), 'anything')],
    ['DELETE', dispatchDelete(fakeRequest(foreign), 'library/1')],
  ]
  for (const [label, pending] of cases) {
    const [status, code] = await statusAndCode(await pending)
    assert.equal(status, 403, label)
    assert.equal(code, 'CSRF_REJECTED', label)
  }
})

test('GET is never CSRF-gated', async () => {
  // Reads carry no side effect; the old handler had no origin check in GET, and
  // adding one now would break image URLs the browser fetches cross-site.
  const [status] = await statusAndCode(await dispatchGet(fakeRequest({ origin: 'http://evil.test' }), 'does/not/exist'))
  assert.equal(status, 401)
})

test('setup database routes are public at the router and refused by the handler without setup access', async () => {
  // The wizard has no session before the claim, so the router must not gate these.
  // The handler's setup-access check answers first, so no database read or rate-limit
  // counter is touched for an anonymous caller.
  assert.equal(matchRoute(GET_ROUTES, 'setup/database')!.route.access, 'public')
  assert.equal(matchRoute(POST_ROUTES, 'setup/database/test')!.route.access, 'public')
  assert.deepEqual(await statusAndCode(await dispatchGet(fakeRequest(), 'setup/database')), [401, 'SETUP_SESSION_INVALID'])
  assert.deepEqual(
    await statusAndCode(await dispatchPost(fakeRequest({ origin: 'http://musecanvas.test' }), 'setup/database/test')),
    [401, 'SETUP_SESSION_INVALID'],
  )
})

test('turn recovery has a named turnId, is actor-only and real dispatch rejects anonymous before store access', async () => {
  const path = API_ENDPOINTS.canvases.agent.turn(SAMPLE_UUID, SAMPLE_UUID).replace(/^\/api\//, '')
  const matched = matchRoute(GET_ROUTES, path)!
  assert.equal(matched.route.path, 'canvases/:id/agent/turns/:turnId'); assert.equal(matched.route.access, 'actor')
  assert.deepEqual(matched.params, { id: SAMPLE_UUID, turnId: SAMPLE_UUID })
  assert.deepEqual(await statusAndCode(await dispatchGet(fakeRequest(), path)), [401, 'UNAUTHORIZED'])
  assert.deepEqual(await statusAndCode(await dispatchGet(fakeRequest(), `canvases/${SAMPLE_UUID}/agent/turns/deadbeef`)), [401, 'UNAUTHORIZED'])
  assert.equal(matchRoute(GET_ROUTES, `canvases/${SAMPLE_UUID}/agent/turns/not-a-uuid`), null)
  assert.equal(matchRoute(GET_ROUTES, `${path}/extra`), null)
})

test('media object and upload routes are public and match the contract paths', () => {
  // Both are authorized by the signature in the URL, so the router must not add a session gate.
  assert.equal(matchRoute(GET_ROUTES, 'media/object')!.route.access, 'public')
  assert.equal(matchRoute(POST_ROUTES, 'media/upload')!.route.access, 'public')
  assert.ok(matchRoute(GET_ROUTES, API_ENDPOINTS.media.object.replace(/^\/api\//, '')))
  assert.ok(matchRoute(POST_ROUTES, API_ENDPOINTS.media.upload.replace(/^\/api\//, '')))
})

test('media upload has no origin exemption: same-origin passes the CSRF check, cross-origin is rejected', async () => {
  // pipeline.ts special-cases nothing for media/upload. A browser upload carries the app's own
  // Origin, which mutationOriginValid accepts, so the normal check is enough.
  assert.equal(mutationOriginValid(fakeRequest({ origin: 'http://musecanvas.test' })), true)
  const [status, code] = await statusAndCode(await dispatchPost(fakeRequest({ origin: 'http://evil.test' }), 'media/upload'))
  assert.equal(status, 403)
  assert.equal(code, 'CSRF_REJECTED')
})
