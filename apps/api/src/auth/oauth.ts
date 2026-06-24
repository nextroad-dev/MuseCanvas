import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// OAuth provider integration for GitHub and Google.
//
// Design constraints (see docs/002-ui-oauth-provider-credentials/design.md):
// - Client secrets are read from server-side env only; never returned to the client.
// - All third-party errors are mapped to platform error codes; raw provider
//   messages are never surfaced to the caller.
// - Pure, explicitly-parameterized functions where possible so they are unit-testable
//   without live network access.

export type OAuthProvider = 'github' | 'google'

export interface OAuthProfile {
  providerSubject: string
  email: string
  emailVerified: boolean
  displayName?: string
  avatarUrl?: string
}

export interface OAuthTokens {
  accessToken: string
  idToken?: string
}

export interface OAuthRuntimeConfig {
  clientId: string
  clientSecret: string
  redirectBaseUrl: string
}

export const OAUTH_PROVIDERS: OAuthProvider[] = ['github', 'google']
export const PROVIDER_LABELS: Record<OAuthProvider, string> = { github: 'GitHub', google: 'Google' }

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return value === 'github' || value === 'google'
}

export function envOAuthConfig(provider: OAuthProvider): OAuthRuntimeConfig {
  return {
    clientId: (provider === 'github' ? process.env.OAUTH_GITHUB_CLIENT_ID : process.env.OAUTH_GOOGLE_CLIENT_ID) || '',
    clientSecret: (provider === 'github' ? process.env.OAUTH_GITHUB_CLIENT_SECRET : process.env.OAUTH_GOOGLE_CLIENT_SECRET) || '',
    redirectBaseUrl: process.env.OAUTH_REDIRECT_BASE_URL || '',
  }
}

function clientId(provider: OAuthProvider): string {
  return (provider === 'github' ? process.env.OAUTH_GITHUB_CLIENT_ID : process.env.OAUTH_GOOGLE_CLIENT_ID) || ''
}
function clientSecret(provider: OAuthProvider): string {
  return (provider === 'github' ? process.env.OAUTH_GITHUB_CLIENT_SECRET : process.env.OAUTH_GOOGLE_CLIENT_SECRET) || ''
}

/** True only when both Client ID and Secret are configured for the provider. */
export function providerConfigured(provider: OAuthProvider): boolean {
  return !!clientId(provider) && !!clientSecret(provider)
}

export function runtimeProviderConfigured(config: OAuthRuntimeConfig): boolean {
  return !!config.clientId && !!config.clientSecret && !!config.redirectBaseUrl
}

export function configuredProviders(): { provider: OAuthProvider; label: string; enabled: boolean }[] {
  return OAUTH_PROVIDERS.map((provider) => ({ provider, label: PROVIDER_LABELS[provider], enabled: providerConfigured(provider) }))
}

/** Redirect URI registered with the provider; one fixed callback per provider. */
export function redirectUri(provider: OAuthProvider): string {
  const base = (process.env.OAUTH_REDIRECT_BASE_URL || '').replace(/\/$/, '')
  return `${base}/api/auth/oauth/${provider}/callback`
}

export function runtimeRedirectUri(provider: OAuthProvider, config: OAuthRuntimeConfig): string {
  const base = config.redirectBaseUrl.replace(/\/$/, '')
  return `${base}/api/auth/oauth/${provider}/callback`
}

// ---- PKCE / state / nonce ------------------------------------------------

const base64url = (buffer: Buffer) => buffer.toString('base64url')

export function createPkceVerifier(): string {
  return base64url(randomBytes(32))
}

/** PKCE S256 challenge = base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

// ---- Authorize URL -------------------------------------------------------

export interface AuthorizeParams {
  state: string
  pkceChallenge: string
  nonce: string
}

export function authorizeUrl(provider: OAuthProvider, params: AuthorizeParams): string {
  return authorizeUrlWithConfig(provider, envOAuthConfig(provider), params)
}

export function authorizeUrlWithConfig(provider: OAuthProvider, config: OAuthRuntimeConfig, params: AuthorizeParams): string {
  if (provider === 'github') {
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', runtimeRedirectUri(provider, config))
    url.searchParams.set('scope', 'read:user user:email')
    url.searchParams.set('state', params.state)
    // GitHub supports PKCE; include the challenge for defense in depth.
    url.searchParams.set('code_challenge', params.pkceChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('allow_signup', 'false')
    return url.toString()
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', runtimeRedirectUri(provider, config))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', params.state)
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('code_challenge', params.pkceChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('access_type', 'online')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

// ---- Token exchange ------------------------------------------------------

export async function exchangeCode(provider: OAuthProvider, code: string, pkceVerifier: string): Promise<OAuthTokens> {
  return exchangeCodeWithConfig(provider, envOAuthConfig(provider), code, pkceVerifier)
}

export async function exchangeCodeWithConfig(provider: OAuthProvider, config: OAuthRuntimeConfig, code: string, pkceVerifier: string): Promise<OAuthTokens> {
  if (provider === 'github') {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: runtimeRedirectUri(provider, config),
        code_verifier: pkceVerifier,
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error('OAUTH_EXCHANGE_FAILED')
    const data = (await response.json()) as { access_token?: string; error?: string }
    if (!data.access_token) throw new Error('OAUTH_EXCHANGE_FAILED')
    return { accessToken: data.access_token }
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: runtimeRedirectUri(provider, config),
      grant_type: 'authorization_code',
      code_verifier: pkceVerifier,
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('OAUTH_EXCHANGE_FAILED')
  const data = (await response.json()) as { access_token?: string; id_token?: string }
  if (!data.access_token || !data.id_token) throw new Error('OAUTH_EXCHANGE_FAILED')
  return { accessToken: data.access_token, idToken: data.id_token }
}

// ---- Profile -------------------------------------------------------------

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

/**
 * Validate the claims of a Google ID token payload. Extracted from network/JWKS
 * verification so the claim-validation logic can be unit-tested directly.
 */
export function googleProfileFromClaims(claims: Record<string, unknown>, expectedNonce: string): OAuthProfile {
  if (claims.nonce !== expectedNonce) throw new Error('OAUTH_PROFILE_FAILED')
  const sub = typeof claims.sub === 'string' ? claims.sub : ''
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true'
  if (!sub || !email) throw new Error('OAUTH_PROFILE_FAILED')
  return {
    providerSubject: sub,
    email,
    emailVerified,
    displayName: typeof claims.name === 'string' ? claims.name : undefined,
    avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
  }
}

async function fetchGoogleProfile(tokens: OAuthTokens, expectedNonce: string): Promise<OAuthProfile> {
  return fetchGoogleProfileWithConfig(tokens, expectedNonce, envOAuthConfig('google'))
}

async function fetchGoogleProfileWithConfig(tokens: OAuthTokens, expectedNonce: string, config: OAuthRuntimeConfig): Promise<OAuthProfile> {
  if (!tokens.idToken) throw new Error('OAUTH_PROFILE_FAILED')
  try {
    const { payload } = await jwtVerify(tokens.idToken, googleJwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: config.clientId,
    })
    return googleProfileFromClaims(payload as Record<string, unknown>, expectedNonce)
  } catch (error) {
    if (error instanceof Error && error.message === 'OAUTH_PROFILE_FAILED') throw error
    throw new Error('OAUTH_PROFILE_FAILED')
  }
}

interface GitHubEmail { email: string; primary: boolean; verified: boolean }

async function fetchGitHubProfile(tokens: OAuthTokens): Promise<OAuthProfile> {
  const headers = { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'MuseCanvas' }
  const userResponse = await fetch('https://api.github.com/user', { headers, signal: AbortSignal.timeout(15000) })
  if (!userResponse.ok) throw new Error('OAUTH_PROFILE_FAILED')
  const user = (await userResponse.json()) as { id?: number; login?: string; name?: string; avatar_url?: string }
  if (!user.id) throw new Error('OAUTH_PROFILE_FAILED')

  const emailResponse = await fetch('https://api.github.com/user/emails', { headers, signal: AbortSignal.timeout(15000) })
  if (!emailResponse.ok) throw new Error('OAUTH_PROFILE_FAILED')
  const emails = (await emailResponse.json()) as GitHubEmail[]
  const primary = selectGitHubEmail(emails)
  if (!primary) throw new Error('OAUTH_EMAIL_UNAVAILABLE')

  return {
    providerSubject: String(user.id),
    email: primary.email.toLowerCase(),
    emailVerified: primary.verified,
    displayName: user.name || user.login || undefined,
    avatarUrl: user.avatar_url || undefined,
  }
}

/** Prefer the verified primary email; fall back to any verified email. */
export function selectGitHubEmail(emails: GitHubEmail[]): GitHubEmail | undefined {
  if (!Array.isArray(emails)) return undefined
  return emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified)
}

export async function fetchProfile(provider: OAuthProvider, tokens: OAuthTokens, expectedNonce: string): Promise<OAuthProfile> {
  return provider === 'github' ? fetchGitHubProfile(tokens) : fetchGoogleProfile(tokens, expectedNonce)
}

export async function fetchProfileWithConfig(provider: OAuthProvider, config: OAuthRuntimeConfig, tokens: OAuthTokens, expectedNonce: string): Promise<OAuthProfile> {
  return provider === 'github' ? fetchGitHubProfile(tokens) : fetchGoogleProfileWithConfig(tokens, expectedNonce, config)
}
