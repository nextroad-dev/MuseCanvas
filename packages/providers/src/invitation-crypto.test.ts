import assert from 'node:assert/strict'
import test from 'node:test'

process.env.APP_MASTER_KEY = process.env.APP_MASTER_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const { encryptForPurpose, decryptForPurpose } = await import('./crypto')

test('invitation code round-trips through its purpose key', () => {
  const code = 'K7xQp2mZr9VbNc4TdWef'
  const envelope = encryptForPurpose(code, 'invitation-codes')
  assert.notEqual(envelope.ciphertext, code)
  assert.equal(decryptForPurpose(envelope.ciphertext, 'invitation-codes', envelope.keyId), code)
})

test('invitation codes cannot be decrypted under another purpose key', () => {
  const envelope = encryptForPurpose('secret-invite', 'invitation-codes')
  assert.throws(() => decryptForPurpose(envelope.ciphertext, 'oauth-credentials', envelope.keyId))
})
