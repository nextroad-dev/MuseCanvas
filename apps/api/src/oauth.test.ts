import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  authorizeUrl,
  configuredProviders,
  createPkceVerifier,
  googleProfileFromClaims,
  isOAuthProvider,
  pkceChallenge,
  providerConfigured,
  redirectUri,
  selectGitHubEmail,
} from './oauth'

test('PKCE challenge is the base64url sha256 of the verifier', () => {
  const verifier = createPkceVerifier()
  const expected = createHash('sha256').update(verifier).digest('base64url')
  assert.equal(pkceChallenge(verifier), expected)
  assert.notEqual(createPkceVerifier(), createPkceVerifier())
})

test('provider type guard accepts only known providers', () => {
  assert.equal(isOAuthProvider('github'), true)
  assert.equal(isOAuthProvider('google'), true)
  assert.equal(isOAuthProvider('facebook'), false)
  assert.equal(isOAuthProvider(undefined), false)
})

test('providerConfigured requires both client id and secret', () => {
  delete process.env.OAUTH_GITHUB_CLIENT_ID
  delete process.env.OAUTH_GITHUB_CLIENT_SECRET
  assert.equal(providerConfigured('github'), false)
  process.env.OAUTH_GITHUB_CLIENT_ID = 'id'
  assert.equal(providerConfigured('github'), false)
  process.env.OAUTH_GITHUB_CLIENT_SECRET = 'secret'
  assert.equal(providerConfigured('github'), true)
  delete process.env.OAUTH_GITHUB_CLIENT_ID
  delete process.env.OAUTH_GITHUB_CLIENT_SECRET
})

test('configuredProviders reflects disabled state when env is absent', () => {
  delete process.env.OAUTH_GITHUB_CLIENT_ID
  delete process.env.OAUTH_GITHUB_CLIENT_SECRET
  delete process.env.OAUTH_GOOGLE_CLIENT_ID
  delete process.env.OAUTH_GOOGLE_CLIENT_SECRET
  const providers = configuredProviders()
  assert.deepEqual(
    providers.map((p) => ({ provider: p.provider, enabled: p.enabled })),
    [
      { provider: 'github', enabled: false },
      { provider: 'google', enabled: false },
    ],
  )
  assert.equal(providers[0].label, 'GitHub')
  assert.equal(providers[1].label, 'Google')
})

test('redirectUri is derived from the configured base url', () => {
  process.env.OAUTH_REDIRECT_BASE_URL = 'https://app.example.com/'
  assert.equal(redirectUri('github'), 'https://app.example.com/api/auth/oauth/github/callback')
  assert.equal(redirectUri('google'), 'https://app.example.com/api/auth/oauth/google/callback')
})

test('GitHub authorize URL carries scope, state and PKCE challenge', () => {
  process.env.OAUTH_GITHUB_CLIENT_ID = 'gh-client'
  process.env.OAUTH_REDIRECT_BASE_URL = 'https://app.example.com'
  const url = new URL(authorizeUrl('github', { state: 'st', pkceChallenge: 'ch', nonce: 'no' }))
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), 'gh-client')
  assert.equal(url.searchParams.get('scope'), 'read:user user:email')
  assert.equal(url.searchParams.get('state'), 'st')
  assert.equal(url.searchParams.get('code_challenge'), 'ch')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  delete process.env.OAUTH_GITHUB_CLIENT_ID
})

test('Google authorize URL requests openid scope and carries the nonce', () => {
  process.env.OAUTH_GOOGLE_CLIENT_ID = 'goog-client'
  process.env.OAUTH_REDIRECT_BASE_URL = 'https://app.example.com'
  const url = new URL(authorizeUrl('google', { state: 'st', pkceChallenge: 'ch', nonce: 'no' }))
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('scope'), 'openid email profile')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('nonce'), 'no')
  assert.equal(url.searchParams.get('code_challenge'), 'ch')
  delete process.env.OAUTH_GOOGLE_CLIENT_ID
})

test('Google claim validation enforces nonce, subject and email', () => {
  const claims = { sub: '123', email: 'User@Example.com', email_verified: true, nonce: 'n1', name: 'User', picture: 'https://avatar' }
  const profile = googleProfileFromClaims(claims, 'n1')
  assert.equal(profile.providerSubject, '123')
  assert.equal(profile.email, 'user@example.com')
  assert.equal(profile.emailVerified, true)
  assert.equal(profile.displayName, 'User')

  assert.throws(() => googleProfileFromClaims(claims, 'wrong'), /OAUTH_PROFILE_FAILED/)
  assert.throws(() => googleProfileFromClaims({ email: 'a@b.com', nonce: 'n1' }, 'n1'), /OAUTH_PROFILE_FAILED/)
  assert.throws(() => googleProfileFromClaims({ sub: '1', nonce: 'n1' }, 'n1'), /OAUTH_PROFILE_FAILED/)
})

test('Google claim validation treats unverified email as not verified', () => {
  const profile = googleProfileFromClaims({ sub: '1', email: 'a@b.com', email_verified: false, nonce: 'n' }, 'n')
  assert.equal(profile.emailVerified, false)
})

test('GitHub email selection prefers the verified primary address', () => {
  const emails = [
    { email: 'secondary@example.com', primary: false, verified: true },
    { email: 'primary@example.com', primary: true, verified: true },
  ]
  assert.equal(selectGitHubEmail(emails)?.email, 'primary@example.com')
})

test('GitHub email selection falls back to any verified address', () => {
  const emails = [
    { email: 'unverified-primary@example.com', primary: true, verified: false },
    { email: 'verified@example.com', primary: false, verified: true },
  ]
  assert.equal(selectGitHubEmail(emails)?.email, 'verified@example.com')
})

test('GitHub email selection returns undefined when nothing is verified', () => {
  assert.equal(selectGitHubEmail([{ email: 'x@y.com', primary: true, verified: false }]), undefined)
  assert.equal(selectGitHubEmail([]), undefined)
})
