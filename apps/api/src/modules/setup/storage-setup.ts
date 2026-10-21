import type { StorageSettingsRow, StorageConnectionStatus, UpdateStorageSettingsInput, ResolvedLocalStorageConfig, StorageDriverKind } from '@musecanvas/database'
import { clampSignedUrlTtlSeconds } from '@musecanvas/database'
import type { StorageProbeResult } from '../../shared/storage'
import type { StorageSecretAction, ValidStorageInput } from './validation'

// Decision logic for the setup-flow storage save and test endpoints. Every database,
// crypto and probe effect arrives through StorageSetupDeps, so the driver x action
// matrix is unit-tested without a database. The handlers map outcomes to HTTP responses.
//
// Rules:
// - The raw singleton row is the base for omitted fields, never the resolved config.
//   A stored secret that cannot be decrypted therefore never blocks a save or test that
//   supplies a new secret, and never blocks a 'local' save at all.
// - The stored secret is decrypted only when the request keeps it AND driver is 's3'.
//   An unreadable stored secret then answers STORAGE_SECRET_REENTER_REQUIRED.
// - Switching driver preserves the S3 columns and the S3 secret, so switching back works.

export const STORAGE_SECRET_REENTER_REQUIRED = 'STORAGE_SECRET_REENTER_REQUIRED'
export const STORAGE_SECRET_REENTER_MESSAGE = '已保存的对象存储密钥无法读取，请重新输入访问密钥后再保存'
const LOCAL_ROOT_REQUIRED_MESSAGE = '本地存储必须填写存储目录'

export interface MergedStorageSettings {
  driver: StorageDriverKind
  localRoot: string | null
  endpoint: string | null
  publicEndpoint: string | null
  region: string
  bucket: string | null
  accessKeyId: string | null
  /** Plaintext for the S3 probe only. Never logged, persisted in clear or returned. */
  secretAccessKey: string | null
  signedUrlTtlSeconds: number
}

export interface StorageSetupFailure {
  ok: false
  status: 400 | 409 | 500
  code: string
  message: string
}

export type StorageSetupOutcome = { ok: true; settings: MergedStorageSettings } | StorageSetupFailure

export interface StorageSetupDeps {
  loadRow: () => Promise<StorageSettingsRow | null>
  /** Decrypts row.secret_encrypted. Any throw is treated as an unreadable stored secret. */
  decryptSecret: (row: StorageSettingsRow) => string
  encryptSecret: (plaintext: string) => { ciphertext: string; fingerprint: string; keyId: string }
  probeLocal: (config: ResolvedLocalStorageConfig) => Promise<StorageProbeResult>
  probeS3: (settings: MergedStorageSettings) => Promise<void>
  persist: (input: UpdateStorageSettingsInput) => Promise<void>
}

function failure(status: StorageSetupFailure['status'], code: string, message: string): StorageSetupFailure {
  return { ok: false, status, code, message }
}

type SecretResolution = { ok: true; secret: string | null } | { ok: false }

/**
 * Plaintext the S3 probe needs. A new secret never touches the stored ciphertext.
 * A kept secret is decrypted only for driver 's3'; 'local' never reads it.
 */
export function resolveSecretForDriver(
  driver: StorageDriverKind,
  action: StorageSecretAction,
  row: StorageSettingsRow | null,
  decryptSecret: (row: StorageSettingsRow) => string,
): SecretResolution {
  if (action.kind === 'set') return { ok: true, secret: action.secret }
  if (action.kind === 'clear' || driver !== 's3' || !row?.secret_encrypted) return { ok: true, secret: null }
  try {
    const plaintext = decryptSecret(row).trim()
    return { ok: true, secret: plaintext === '' ? null : plaintext }
  } catch {
    return { ok: false }
  }
}

/**
 * An explicit request driver wins. When the request omits it the stored driver is kept (the web
 * form sends `driver` only when the user switches it), and with no stored row it is 's3'.
 * Defaulting to 's3' here would silently flip a local-disk config back to S3 on an unrelated edit.
 */
export function effectiveStorageDriver(valid: ValidStorageInput, row: StorageSettingsRow | null): StorageDriverKind {
  return valid.driver ?? (row?.storage_driver === 'local' ? 'local' : 's3')
}

/** Omitted fields come from the raw row; the driver follows effectiveStorageDriver. */
export function mergeStorageSettings(
  valid: ValidStorageInput,
  secret: string | null,
  row: StorageSettingsRow | null,
): MergedStorageSettings {
  return {
    driver: effectiveStorageDriver(valid, row),
    localRoot: valid.localRoot ?? row?.local_root ?? null,
    endpoint: valid.endpoint ?? row?.endpoint ?? null,
    publicEndpoint: valid.publicEndpoint ?? row?.public_endpoint ?? null,
    region: valid.region ?? row?.region ?? 'us-east-1',
    bucket: valid.bucket ?? row?.bucket ?? null,
    accessKeyId: valid.accessKeyId ?? row?.access_key_id ?? null,
    secretAccessKey: secret,
    signedUrlTtlSeconds: valid.signedUrlTtlSeconds ?? clampSignedUrlTtlSeconds(row?.signed_url_ttl_seconds),
  }
}

function secretWriteFields(
  action: StorageSecretAction,
  encrypt: StorageSetupDeps['encryptSecret'],
): Pick<UpdateStorageSettingsInput, 'secretCiphertext' | 'secretFingerprint' | 'encryptionKeyId' | 'clearSecret'> {
  if (action.kind === 'clear') return { clearSecret: true }
  if (action.kind === 'set') {
    const encrypted = encrypt(action.secret)
    return { secretCiphertext: encrypted.ciphertext, secretFingerprint: encrypted.fingerprint, encryptionKeyId: encrypted.keyId }
  }
  // 'keep' writes no secret columns, so the stored ciphertext is left as it is.
  return {}
}

function writeInput(
  merged: MergedStorageSettings,
  action: StorageSecretAction,
  encrypt: StorageSetupDeps['encryptSecret'],
  status: StorageConnectionStatus,
): UpdateStorageSettingsInput {
  return {
    driver: merged.driver,
    localRoot: merged.localRoot,
    endpoint: merged.endpoint,
    publicEndpoint: merged.publicEndpoint,
    region: merged.region,
    bucket: merged.bucket,
    accessKeyId: merged.accessKeyId,
    signedUrlTtlSeconds: merged.signedUrlTtlSeconds,
    status,
    ...secretWriteFields(action, encrypt),
  }
}

async function prepare(
  valid: ValidStorageInput,
  deps: StorageSetupDeps,
): Promise<{ ok: true; merged: MergedStorageSettings } | StorageSetupFailure> {
  let row: StorageSettingsRow | null
  try {
    row = await deps.loadRow()
  } catch {
    return failure(500, 'INTERNAL_ERROR', '读取对象存储设置失败')
  }
  const resolved = resolveSecretForDriver(effectiveStorageDriver(valid, row), valid.secret, row, deps.decryptSecret)
  if (!resolved.ok) return failure(409, STORAGE_SECRET_REENTER_REQUIRED, STORAGE_SECRET_REENTER_MESSAGE)
  return { ok: true, merged: mergeStorageSettings(valid, resolved.secret, row) }
}

/** Save only: persists without probing. Local saves persist 'configured'; S3 keeps its bucket rule. */
export async function runStorageSave(valid: ValidStorageInput, deps: StorageSetupDeps): Promise<StorageSetupOutcome> {
  const prepared = await prepare(valid, deps)
  if (!prepared.ok) return prepared
  const { merged } = prepared
  const status: StorageConnectionStatus = merged.driver === 'local' || merged.bucket ? 'configured' : 'not_configured'
  try {
    await deps.persist(writeInput(merged, valid.secret, deps.encryptSecret, status))
  } catch {
    return failure(500, 'INTERNAL_ERROR', '保存对象存储设置失败')
  }
  return { ok: true, settings: merged }
}

/** Test then save: probes the effective driver and persists 'verified' only after a successful probe. */
export async function runStorageTest(valid: ValidStorageInput, deps: StorageSetupDeps): Promise<StorageSetupOutcome> {
  const prepared = await prepare(valid, deps)
  if (!prepared.ok) return prepared
  const { merged } = prepared
  if (merged.driver === 'local') {
    if (!merged.localRoot) return failure(400, 'INVALID_INPUT', LOCAL_ROOT_REQUIRED_MESSAGE)
    const probe = await deps.probeLocal({
      driver: 'local',
      source: 'database',
      configured: true,
      root: merged.localRoot,
      signedUrlTtlSeconds: merged.signedUrlTtlSeconds,
      revision: 0,
    })
    if (!probe.ok) return failure(400, probe.code, probe.message)
  } else {
    if (!merged.bucket || !merged.accessKeyId || !merged.secretAccessKey) {
      return failure(400, 'STORAGE_TEST_FAILED', '对象存储访问信息尚未配置完整')
    }
    try {
      await deps.probeS3(merged)
    } catch {
      return failure(400, 'STORAGE_TEST_FAILED', '对象存储连接测试失败，请检查配置')
    }
  }
  try {
    await deps.persist(writeInput(merged, valid.secret, deps.encryptSecret, 'verified'))
  } catch {
    return failure(500, 'INTERNAL_ERROR', '保存对象存储设置失败')
  }
  return { ok: true, settings: merged }
}
