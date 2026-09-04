/**
 * Idempotent one-time seed for bundled dev services (Mailpit + MinIO).
 *
 * Invoked by db-migrate after the SQL migration and the base seed. It only
 * runs when BUNDLED_SERVICES=true; every other deployment exits 0 without
 * touching the database, so production/external environments receive no
 * defaults.
 *
 * When the onboarding state is still pending and the SMTP / object-storage
 * singleton rows are unconfigured (status not_configured with no identity
 * fields yet), this seeds developer Mailpit values and the bundled MinIO
 * application values (access key from MINIO_ROOT_USER, secret from
 * MINIO_ROOT_PASSWORD encrypted under APP_MASTER_KEY). Rows are marked
 * `configured`, never `verified`: onboarding still has to test them, and the
 * repository keeps the corresponding onboarding sections pending until then.
 * Rows that already carry user configuration are never overwritten, so
 * re-runs are safe.
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
import { encryptForPurpose } from '../packages/providers/src/index'

if (process.env.BUNDLED_SERVICES !== 'true') {
  console.log('seed-bundled-services: BUNDLED_SERVICES is not true, skipping')
  process.exit(0)
}

for (const name of ['DATABASE_URL', 'APP_MASTER_KEY', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD']) {
  if (!process.env[name] || !String(process.env[name]).trim()) {
    console.error(`seed-bundled-services: ${name} is required when BUNDLED_SERVICES=true`)
    process.exit(1)
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

const state = await pool.query('SELECT status FROM onboarding_state WHERE singleton = true')
if ((state.rows[0]?.status ?? 'pending') !== 'pending') {
  console.log('seed-bundled-services: onboarding already complete, skipping')
  await pool.end()
  process.exit(0)
}

const smtp = await getSmtpSettings(pool)
if (smtp && !(smtp.status === 'not_configured' && smtp.host == null)) {
  skipped.push(`smtp:${smtp.status}`)
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
if (storage && !(storage.status === 'not_configured' && storage.endpoint == null && storage.accessKeyId == null)) {
  skipped.push(`object-storage:${storage.status}`)
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
