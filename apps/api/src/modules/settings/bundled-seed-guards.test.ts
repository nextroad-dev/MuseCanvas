import assert from 'node:assert/strict'
import test from 'node:test'
// The bundled seed script ships without a package test runner, so its row
// eligibility predicates are covered here where the api suite executes them.
// Importing the script is side-effect free: it only seeds when invoked
// directly as `tsx scripts/seed-bundled-services.ts`.
import { shouldSeedBundledSmtp, shouldSeedBundledStorage } from '../../../../../scripts/seed-bundled-services'
import type { SmtpSettingsEntity, StorageSettingsEntity } from '@musecanvas/database'

function smtpRow(overrides: Partial<SmtpSettingsEntity>): SmtpSettingsEntity {
  return {
    host: null,
    port: null,
    tlsMode: 'none',
    username: null,
    fromAddress: null,
    fromName: null,
    passwordCiphertext: null,
    passwordFingerprint: null,
    encryptionKeyId: null,
    hasSecret: false,
    status: 'not_configured',
    revision: 1,
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
}

function storageRow(overrides: Partial<StorageSettingsEntity>): StorageSettingsEntity {
  return {
    endpoint: null,
    publicEndpoint: null,
    region: 'us-east-1',
    bucket: null,
    accessKeyId: null,
    secretCiphertext: null,
    secretFingerprint: null,
    encryptionKeyId: null,
    signedUrlTtlSeconds: 900,
    hasSecret: false,
    status: 'not_configured',
    revision: 1,
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  }
}

test('completed onboarding still backfills rows that were never configured', () => {
  // Upgrade scenario: onboarding finished long ago, yet both singletons are
  // empty because the operator never set them up. No onboarding input gates
  // the decision — unowned rows are eligible.
  assert.equal(shouldSeedBundledSmtp(smtpRow({})), true)
  assert.equal(shouldSeedBundledSmtp(null), true)
  assert.equal(shouldSeedBundledStorage(storageRow({})), true)
  assert.equal(shouldSeedBundledStorage(null), true)
})

test('operator-owned SMTP configuration is never eligible for bundled seeding', () => {
  const ownedRows: Array<Partial<SmtpSettingsEntity>> = [
    { status: 'configured', host: 'mailpit', port: 1025 },
    { status: 'verified', host: 'smtp.example.com', port: 587 },
    { status: 'error' },
    { host: 'smtp.example.com' },
    { port: 587 },
    { tlsMode: 'starttls' },
    { username: 'operator' },
    { fromAddress: 'admin@example.com' },
    { fromName: 'MuseCanvas' },
    { passwordCiphertext: 'ciphertext', hasSecret: true },
    { passwordFingerprint: 'fingerprint' },
    { encryptionKeyId: 'key-id' },
  ]

  for (const owned of ownedRows) {
    assert.equal(shouldSeedBundledSmtp(smtpRow(owned)), false, JSON.stringify(owned))
  }
})

test('operator-owned object-storage configuration is never eligible for bundled seeding', () => {
  const ownedRows: Array<Partial<StorageSettingsEntity>> = [
    { status: 'configured', endpoint: 'http://minio:9000', accessKeyId: 'musecanvas' },
    { status: 'verified', endpoint: 'https://s3.example.com', accessKeyId: 'AKID' },
    { status: 'error' },
    { endpoint: 'http://minio:9000' },
    { publicEndpoint: 'https://assets.example.com' },
    { region: 'eu-central-1' },
    { bucket: 'operator-bucket' },
    { accessKeyId: 'AKID' },
    { secretCiphertext: 'ciphertext', hasSecret: true },
    { secretFingerprint: 'fingerprint' },
    { encryptionKeyId: 'key-id' },
    { signedUrlTtlSeconds: 1_800 },
  ]

  for (const owned of ownedRows) {
    assert.equal(shouldSeedBundledStorage(storageRow(owned)), false, JSON.stringify(owned))
  }
})
