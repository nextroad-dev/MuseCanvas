import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldUseSecureCookie } from '../../auth/security'

// Locks the Secure-default contract used by the setup claim cookie and the
// first-admin session cookie: production/HTTPS defaults to Secure, while an
// explicit COOKIE_SECURE keeps overriding for one compatibility release.
function withEnv(nodeEnv: string | undefined, cookieSecure: string | undefined, fn: () => void): void {
  const env = process.env as Record<string, string | undefined>
  const prevNode = env.NODE_ENV
  const prevCookie = env.COOKIE_SECURE
  try {
    if (nodeEnv === undefined) delete env.NODE_ENV
    else env.NODE_ENV = nodeEnv
    if (cookieSecure === undefined) delete env.COOKIE_SECURE
    else env.COOKIE_SECURE = cookieSecure
    fn()
  } finally {
    if (prevNode === undefined) delete env.NODE_ENV
    else env.NODE_ENV = prevNode
    if (prevCookie === undefined) delete env.COOKIE_SECURE
    else env.COOKIE_SECURE = prevCookie
  }
}

test('setup cookies default to Secure in production even for http origins', () => {
  withEnv('production', undefined, () => {
    assert.equal(shouldUseSecureCookie('http://localhost:8080'), true)
    assert.equal(shouldUseSecureCookie(''), true)
  })
})

test('setup cookies default to Secure for https origins outside production', () => {
  withEnv('development', undefined, () => {
    assert.equal(shouldUseSecureCookie('https://studio.example.com'), true)
  })
})

test('setup cookies stay non-Secure for plaintext origins outside production', () => {
  withEnv('development', undefined, () => {
    assert.equal(shouldUseSecureCookie('http://localhost:8080'), false)
    assert.equal(shouldUseSecureCookie(''), false)
  })
})

test('explicit COOKIE_SECURE override wins over environment and origin', () => {
  withEnv('development', 'true', () => {
    assert.equal(shouldUseSecureCookie('http://localhost:8080'), true)
  })
  withEnv('production', 'false', () => {
    assert.equal(shouldUseSecureCookie('https://studio.example.com'), false)
  })
})
