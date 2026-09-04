/**
 * Idempotent seed for bundled dev services (Mailpit + MinIO).
 *
 * Invoked by db-migrate after the SQL migration and the base seed. It only
 * runs when BUNDLED_SERVICES=true; every other deployment exits 0 without
 * touching the database, so production/external environments receive no
 * defaults.
 *
 * Eligibility is decided per settings row, independent of onboarding status,
 * so upgrades that complete onboarding still backfill bundled defaults for
 * rows the operator never configured: an SMTP / object-storage singleton
 * that is still entirely at its schema defaults receives the developer
 * Mailpit values / bundled MinIO application values (access key from
 * MINIO_ROOT_USER, secret from MINIO_ROOT_PASSWORD
 * encrypted under APP_MASTER_KEY). Rows are marked `configured`, never
 * `verified`: onboarding still has to test them, and the repository keeps
 * the corresponding onboarding sections pending until then. Rows that
 * already carry operator configuration are never overwritten, so re-runs
 * are safe at any point in the install lifecycle.
 *
 * Required env (bundled db-migrate only): DATABASE_URL, APP_MASTER_KEY,
 * MINIO_ROOT_USER, MINIO_ROOT_PASSWORD, BUNDLED_SERVICES=true.
 */
import {
  db,
  getSmtpSettings,
  getStorageSettings,
  updateSmtpSettings,
  updateStorageSettings,
} from '../packages/database/src/index'
import type { SmtpSettingsEntity, StorageSettingsEntity } from '../packages/database/src/index'
import { encryptForPurpose } from '../packages/providers/src/index'

/**
 * True when the SMTP singleton carries no operator configuration and may
 * receive the bundled Mailpit defaults. Anything already configured,
 * verified, or errored is left untouched.
 */
export function shouldSeedBundledSmtp(smtp: SmtpSettingsEntity | null): boolean {
  return (
    !smtp ||
    (smtp.status === 'not_configured' &&
      smtp.host == null &&
      smtp.port == null &&
      smtp.tlsMode === 'none' &&
      smtp.username == null &&
      smtp.fromAddress == null &&
      smtp.fromName == null &&
      smtp.passwordCiphertext == null &&
      smtp.passwordFingerprint == null &&
      smtp.encryptionKeyId == null &&
      !smtp.hasSecret)
  )
}

/**
 * True only when the object-storage singleton is still exactly at the
 * database defaults. A value in any configurable field establishes operator
 * ownership and must survive every bundled-stack restart.
 */
export function shouldSeedBundledStorage(storage: StorageSettingsEntity | null): boolean {
  return (
    !storage ||
    (storage.status === 'not_configured' &&
      storage.endpoint == null &&
      storage.publicEndpoint == null &&
      storage.region === 'us-east-1' &&
      storage.bucket == null &&
      storage.accessKeyId == null &&
      storage.secretCiphertext == null &&
      storage.secretFingerprint == null &&
      storage.encryptionKeyId == null &&
      storage.signedUrlTtlSeconds === 900 &&
      !storage.hasSecret)
  )
}

async function main(): Promise<void> {
  if (process.env.BUNDLED_SERVICES !== 'true') {
    console.log('seed-bundled-services: BUNDLED_SERVICES is not true, skipping')
    return
  }

  for (const name of ['DATABASE_URL', 'APP_MASTER_KEY', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD']) {
    if (!process.env[name] || !String(process.env[name]).trim()) {
      console.error(`seed-bundled-services: ${name} is required when BUNDLED_SERVICES=true`)
      process.exitCode = 1
      return
    }
  }

  const rootUser = String(process.env.MINIO_ROOT_USER).trim()
  const rootPassword = String(process.env.MINIO_ROOT_PASSWORD)

  const pool = db()
  const seeded = []
  const skipped = []

  await pool.query('INSERT INTO onboarding_state(singleton) VALUES(true) ON CONFLICT DO NOTHING')
  await pool.query('INSERT INTO smtp_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING')
  await pool.query('INSERT INTO object_storage_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING')

  const smtp = await getSmtpSettings(pool)
  if (!shouldSeedBundledSmtp(smtp)) {
    skipped.push(`smtp:${smtp?.status ?? 'missing'}`)
  } else {
    await updateSmtpSettings(pool, {
      host: 'mailpit',
      port: 1025,
      tlsMode: 'none',
      username: null,
      fromAddress: 'no-reply@musecanvas.local',
      fromName: 'MuseCanvas',
      status: 'configured',
    })
    seeded.push('smtp:mailpit')
  }

  const storage = await getStorageSettings(pool)
  if (!shouldSeedBundledStorage(storage)) {
    skipped.push(`object-storage:${storage?.status ?? 'missing'}`)
  } else {
    const sealed = encryptForPurpose(rootPassword, 'object-storage-credentials')
    await updateStorageSettings(pool, {
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'musecanvas',
      accessKeyId: rootUser,
      secretCiphertext: sealed.ciphertext,
      secretFingerprint: sealed.fingerprint,
      encryptionKeyId: sealed.keyId,
      signedUrlTtlSeconds: 900,
      status: 'configured',
    })
    seeded.push('object-storage:bundled-minio')
  }

  console.log(
    `seed-bundled-services: seeded [${seeded.join(', ') || 'none'}]` +
      (skipped.length > 0 ? `; left untouched [${skipped.join(', ')}]` : ''),
  )
  await pool.end()
}

// Import-safe: behavior tests import the predicates above without running the
// seed (no top-level await, so the file also transforms under a CommonJS
// package type). A direct `tsx scripts/seed-bundled-services.ts` invocation
// always has the script path as argv[1]; test runners import from `.test.ts`.
if ((process.argv[1] ?? '').endsWith('seed-bundled-services.ts')) {
  main().catch((error) => {
    console.error('seed-bundled-services: failed', error)
    process.exitCode = 1
  })
}
