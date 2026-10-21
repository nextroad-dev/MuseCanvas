import type { ResolvedLocalStorageConfig, ResolvedStorageConfig } from '@musecanvas/database'
import { resolvePublicOrigin, resolveStorageSettings } from '../../modules/settings/runtime'
import { LocalStorageDriver } from './local-driver'
import { S3StorageDriver } from './s3-driver'
import { STORAGE_PROBE_TIMEOUT_MS, STORAGE_TEST_FAILED, StorageDriverError, type StorageDriver } from './types'

export { LocalObjectWriter, LocalStorageDriver, contentTypeForKey, isValidStorageContentType } from './local-driver'
export { S3StorageDriver } from './s3-driver'
export { assertLocalObjectKey, OBJECT_KEY_MAX_LENGTH } from './object-key'
export { signLocalClaims, verifyLocalClaims, type LocalSignedClaims } from './local-url'
export {
  STORAGE_KEY_INVALID,
  STORAGE_LOCAL_UNWRITABLE,
  STORAGE_OBJECT_NOT_FOUND,
  STORAGE_OBJECT_TOO_LARGE,
  STORAGE_TEST_FAILED,
  StorageDriverError,
  type PutIfAbsentOutcome,
  type SignedUpload,
  type StorageDriver,
  type StorageDriverKind,
  type StorageObjectStream,
} from './types'

export type StorageProbeResult = { ok: true } | { ok: false; code: string; message: string }

const PROBE_MESSAGES: Record<string, string> = {
  STORAGE_TEST_FAILED: '对象存储连接测试失败，请检查配置',
  STORAGE_LOCAL_UNWRITABLE: '本地存储目录不可写，请检查路径与挂载权限',
}

/** Chooses the driver for a resolved configuration. Local signing reads the public origin from site settings. */
export function createStorageDriver(config: ResolvedStorageConfig): StorageDriver {
  if (config.driver === 'local') return new LocalStorageDriver(config, { publicOrigin: resolvePublicOrigin })
  return new S3StorageDriver(config)
}

/** Round-trip probe with a caller-chosen timeout. Never throws; failures carry a stable code and a non-secret message. */
export async function probeStorageDriver(config: ResolvedStorageConfig, timeoutMs = STORAGE_PROBE_TIMEOUT_MS): Promise<StorageProbeResult> {
  try {
    await createStorageDriver(config).test(timeoutMs)
    return { ok: true }
  } catch (error) {
    const code = error instanceof StorageDriverError ? error.code : STORAGE_TEST_FAILED
    return { ok: false, code, message: PROBE_MESSAGES[code] ?? PROBE_MESSAGES.STORAGE_TEST_FAILED }
  }
}

/** Setup-flow entry point: writes, reads back and removes a probe object on the given configuration. */
export async function testStorageDriver(config: ResolvedStorageConfig, timeoutMs = STORAGE_PROBE_TIMEOUT_MS): Promise<StorageProbeResult> {
  return probeStorageDriver(config, timeoutMs)
}

/**
 * The effective local configuration, or null when the saved driver is not 'local'.
 * Used by the media endpoints, which exist only for the local driver.
 */
export async function currentLocalStorageConfig(): Promise<ResolvedLocalStorageConfig | null> {
  const settings = await resolveStorageSettings()
  if (settings.driver !== 'local' || !settings.localRoot) return null
  return {
    driver: 'local',
    source: 'database',
    configured: true,
    root: settings.localRoot,
    signedUrlTtlSeconds: settings.signedUrlTtlSeconds,
    revision: settings.revision,
  }
}
