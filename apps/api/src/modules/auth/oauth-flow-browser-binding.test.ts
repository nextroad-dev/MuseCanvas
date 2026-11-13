import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import { handleOAuthCallback, startOAuth } from './oauth-flow'

type Dependencies = NonNullable<Parameters<typeof handleOAuthCallback>[2]>
const origin = 'https://app.example.invalid'

function harness() {
  const records = new Map<string, object>()
  const calls = { consume: 0, exchange: 0, login: 0, link: 0 }
  let actorId: string | null = null
  let exchangeFails = false
  const dependencies: Dependencies = {
    resolvePublicOrigin: async () => origin,
    loginRedirect: async code => NextResponse.redirect(`${origin}/login?error=${code}`),
    oauthSetting: async () => ({
      enabled: true, source: 'database',
      config: { clientId: 'fixture', clientSecret: 'fixture', redirectBaseUrl: origin },
    }),
    redisSet: async (key, value, ttl) => {
      assert.equal(ttl, 600)
      records.set(key, value)
    },
    redisGetDel: async <T>(key: string): Promise<T | null> => {
      calls.consume++
      const value = records.get(key)
      records.delete(key)
      return (value as T | undefined) ?? null
    },
    actorFrom: async () => actorId ? {
      id: actorId, email: 'fixture@example.invalid', role: 'user', status: 'active', createdAt: '',
    } : null,
    exchangeCodeWithConfig: async (_provider, _config, code, verifier) => {
      calls.exchange++
      assert.equal(code, 'fixture-code')
      assert.ok(verifier)
      if (exchangeFails) throw new Error('OAUTH_TOKEN_FAILED')
      return { accessToken: 'fixture-token' }
    },
    fetchProfileWithConfig: async (_provider, _config, _tokens, nonce) => {
      assert.ok(nonce)
      return { providerSubject: 'fixture-subject', email: 'fixture@example.invalid', emailVerified: true }
    },
    // These are the unchanged business/session boundaries; a rejected callback
    // must never reach either (including new-registration/invitation dispatch).
    loginWithIdentity: async () => {
      calls.login++
      const response = NextResponse.redirect(`${origin}/generate`)
      response.cookies.set('muse_session', 'fixture-session', { httpOnly: true })
      return response
    },
    linkIdentity: async userId => {
      calls.link++
      assert.equal(userId, 'initiator')
      return NextResponse.redirect(`${origin}/account?linked=1`)
    },
  }
  async function start(mode: 'login' | 'link' = 'login') {
    const response = await startOAuth('github', mode, mode === 'link' ? 'initiator' : undefined, dependencies)
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!
    const cookie = response.cookies.getAll().find(item => item.name.startsWith('muse_oauth_'))!
    return { state, cookie, response }
  }
  async function callback(state: string, cookie?: { name: string; value: string }, query = 'code=fixture-code', provider: 'github' | 'google' = 'github') {
    const request = new NextRequest(`${origin}/api/auth/oauth/${provider}/callback?state=${encodeURIComponent(state)}&${query}`, {
      headers: cookie ? { cookie: `${cookie.name}=${cookie.value}` } : {},
    })
    return handleOAuthCallback(request, provider, dependencies)
  }
  return { records, calls, start, callback, setActor: (id: string | null) => { actorId = id }, failExchange: () => { exchangeFails = true } }
}

test('missing/wrong browser cookie cannot consume state, exchange code, or issue session; owner succeeds', async () => {
  const h = harness()
  const { state, cookie } = await h.start()
  for (const candidate of [undefined, { ...cookie, value: 'x'.repeat(43) }, { ...cookie, value: 'malformed' }]) {
    const response = await h.callback(state, candidate)
    assert.equal(response.cookies.get('muse_session'), undefined)
    assert.equal(response.cookies.get(cookie.name), undefined)
    assert.match(response.headers.get('location')!, /OAUTH_STATE_EXPIRED/)
  }
  assert.deepEqual(h.calls, { consume: 0, exchange: 0, login: 0, link: 0 })
  assert.equal(h.records.size, 1)
  const response = await h.callback(state, cookie)
  assert.equal(response.cookies.get('muse_session')?.value, 'fixture-session')
  assert.equal(response.cookies.get(cookie.name)?.maxAge, 0)
  assert.equal(h.calls.exchange, 1)
  assert.equal(h.calls.login, 1)
  assert.equal(h.records.size, 0)
  const replay = await h.callback(state, cookie)
  assert.match(replay.headers.get('location')!, /OAUTH_STATE_EXPIRED/)
  assert.equal(replay.cookies.get('muse_session'), undefined)
  assert.equal(h.calls.exchange, 1)
})

test('link callback requires the authenticated initiating actor before consuming state', async () => {
  const h = harness()
  const { state, cookie } = await h.start('link')
  for (const actor of [null, 'different-user']) {
    h.setActor(actor)
    const response = await h.callback(state, cookie)
    assert.match(response.headers.get('location')!, /OAUTH_STATE_EXPIRED/)
    assert.equal(response.cookies.get('muse_session'), undefined)
  }
  assert.deepEqual(h.calls, { consume: 0, exchange: 0, login: 0, link: 0 })
  h.setActor('initiator')
  const response = await h.callback(state, cookie)
  assert.equal(response.headers.get('location'), `${origin}/account?linked=1`)
  assert.equal(response.cookies.get(cookie.name)?.maxAge, 0)
  assert.equal(h.calls.link, 1)
  assert.equal(h.calls.login, 0)
})

test('independent tab cookies cannot authorize each other and do not overwrite or clear other flows', async () => {
  const h = harness()
  const first = await h.start()
  const second = await h.start()
  assert.notEqual(first.cookie.name, second.cookie.name)
  assert.notEqual(first.cookie.value, second.cookie.value)
  await h.callback(first.state, { name: first.cookie.name, value: second.cookie.value })
  assert.equal(h.calls.consume, 0)
  const response = await h.callback(first.state, first.cookie)
  assert.equal(response.cookies.get(second.cookie.name), undefined)
  await h.callback(second.state, second.cookie)
  assert.equal(h.calls.login, 2)
})

test('provider mismatch and old in-flight states fail closed without consumption', async () => {
  const h = harness()
  const { state, cookie } = await h.start()
  await h.callback(state, cookie, 'code=fixture-code', 'google')
  await h.callback('old-unbound-state', cookie)
  assert.deepEqual(h.calls, { consume: 0, exchange: 0, login: 0, link: 0 })
  assert.equal(h.records.size, 1)
})

test('verified denial, invalid callback, and exchange error clear only that flow cookie', async () => {
  for (const failure of ['error=access_denied', '', 'code=fixture-code']) {
    const h = harness()
    const { state, cookie } = await h.start()
    if (failure === 'code=fixture-code') h.failExchange()
    const response = await h.callback(state, cookie, failure)
    assert.equal(response.cookies.get(cookie.name)?.maxAge, 0)
    assert.equal(response.cookies.get('muse_session'), undefined)
    assert.equal(h.records.size, 0)
    assert.equal(h.calls.login, 0)
    assert.match(response.headers.get('location')!, /OAUTH_(DENIED|INVALID_CALLBACK|TOKEN_FAILED)/)
  }
})

test('denial from another browser cannot consume the legitimate flow', async () => {
  const h = harness()
  const { state, cookie } = await h.start()
  await h.callback(state, undefined, 'error=access_denied')
  assert.equal(h.calls.consume, 0)
  await h.callback(state, cookie)
  assert.equal(h.calls.login, 1)
})

test('browser binding cookie uses the existing secure policy, HttpOnly, Lax, root path, and state TTL', async () => {
  const previous = process.env.COOKIE_SECURE
  try {
    for (const override of [undefined, 'true', 'false']) {
      if (override === undefined) delete process.env.COOKIE_SECURE
      else process.env.COOKIE_SECURE = override
      const h = harness()
      const { cookie, state } = await h.start()
      assert.equal(cookie.httpOnly, true)
      assert.equal(cookie.secure, override !== 'false')
      assert.equal(cookie.sameSite, 'lax')
      assert.equal(cookie.path, '/')
      assert.equal(cookie.maxAge, 600)
      assert.equal(cookie.domain, undefined)
      const cleared = (await h.callback(state, cookie)).cookies.get(cookie.name)!
      assert.equal(cleared.secure, cookie.secure)
      assert.equal(cleared.httpOnly, true)
      assert.equal(cleared.sameSite, 'lax')
      assert.equal(cleared.path, '/')
      assert.equal(cleared.maxAge, 0)
    }
  } finally {
    if (previous === undefined) delete process.env.COOKIE_SECURE
    else process.env.COOKIE_SECURE = previous
  }
})
