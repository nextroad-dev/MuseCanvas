import assert from 'node:assert/strict'
import test from 'node:test'
import {
  invalidateRuntimeSettings,
  resolvePublicOrigin,
  resolveSiteFromRowWithLegacyFallback,
} from './runtime'

const ROW_META = { siteName: 'Canvas', revision: 7, updatedAt: '2026-05-01T00:00:00.000Z' } as const

test('persisted siteUrl wins over legacy env origins and keeps row metadata', () => {
  const resolved = resolveSiteFromRowWithLegacyFallback(
    { ...ROW_META, siteUrl: 'https://cms.example.com' },
    'https://oauth.example.com',
    'https://public.example.com',
  )
  assert.equal(resolved.siteUrl, 'https://cms.example.com')
  assert.equal(resolved.siteName, 'Canvas')
  assert.equal(resolved.revision, 7)
  assert.equal(resolved.updatedAt, ROW_META.updatedAt)
})

test('null persisted siteUrl falls back to PUBLIC_ORIGIN and keeps row metadata', () => {
  // Singleton row created by migration before onboarding ever saved a URL.
  const resolved = resolveSiteFromRowWithLegacyFallback(
    { ...ROW_META, siteUrl: null },
    undefined,
    'https://public.example.com/',
  )
  assert.equal(resolved.siteUrl, 'https://public.example.com')
  assert.equal(resolved.siteName, 'Canvas')
  assert.equal(resolved.revision, 7)
  assert.equal(resolved.updatedAt, ROW_META.updatedAt)
})

test('missing row resolves the canonical OAUTH_REDIRECT_BASE_URL with synthetic metadata', () => {
  const resolved = resolveSiteFromRowWithLegacyFallback(null, 'https://cms.example.com/setup/', undefined)
  assert.equal(resolved.siteUrl, 'https://cms.example.com')
  assert.equal(resolved.siteName, null)
  assert.equal(resolved.revision, 1)
})

test('OAUTH_REDIRECT_BASE_URL takes precedence over PUBLIC_ORIGIN', () => {
  const resolved = resolveSiteFromRowWithLegacyFallback(
    { ...ROW_META, siteUrl: null },
    'https://oauth.example.com',
    'https://public.example.com',
  )
  assert.equal(resolved.siteUrl, 'https://oauth.example.com')
})

test('null persisted siteUrl with no env configured stays null', () => {
  const resolved = resolveSiteFromRowWithLegacyFallback({ ...ROW_META, siteUrl: null }, undefined, undefined)
  assert.equal(resolved.siteUrl, null)
  assert.equal(resolved.siteName, 'Canvas')
  assert.equal(resolved.revision, 7)
})

test('unparseable legacy env origins resolve to null instead of throwing', () => {
  assert.equal(
    resolveSiteFromRowWithLegacyFallback({ ...ROW_META, siteUrl: null }, 'not-a-url', undefined).siteUrl,
    null,
  )
  assert.equal(resolveSiteFromRowWithLegacyFallback(null, undefined, 'ftp://files.example.com').siteUrl, null)
})

test('resolvePublicOrigin serves the legacy env fallback when the database is unreachable', async () => {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    OAUTH_REDIRECT_BASE_URL: process.env.OAUTH_REDIRECT_BASE_URL,
    PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
  }
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/musecanvas'
  delete process.env.OAUTH_REDIRECT_BASE_URL
  process.env.PUBLIC_ORIGIN = 'https://public.example.com/'
  invalidateRuntimeSettings()
  try {
    assert.equal(await resolvePublicOrigin(), 'https://public.example.com')
  } finally {
    if (saved.DATABASE_URL === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved.DATABASE_URL
    if (saved.OAUTH_REDIRECT_BASE_URL === undefined) delete process.env.OAUTH_REDIRECT_BASE_URL
    else process.env.OAUTH_REDIRECT_BASE_URL = saved.OAUTH_REDIRECT_BASE_URL
    if (saved.PUBLIC_ORIGIN === undefined) delete process.env.PUBLIC_ORIGIN
    else process.env.PUBLIC_ORIGIN = saved.PUBLIC_ORIGIN
    invalidateRuntimeSettings()
  }
})
