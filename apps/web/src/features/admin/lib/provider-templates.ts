// Pure helpers for built-in media provider templates (browser-safe, no DOM).
// Keeps template/credential matching logic testable without mounting views.
import type {
  BuiltinProviderTemplate,
  ModelPreset,
  ProviderCredential,
  ProviderCredentialInput,
} from '@/shared/types'

export const ACTIVE_IMAGE_PLUGIN_IDS = ['openai-image', 'seedream-image'] as const
export const ACTIVE_IMAGE_PLUGIN_VERSION = '1.1.0'

export function templateConfiguredCount(
  credentials: ProviderCredential[],
  template: BuiltinProviderTemplate,
): number {
  return credentials.filter(
    (c) =>
      c.configuredFields?.pluginId === template.pluginId &&
      c.configuredFields?.pluginVersion === template.pluginVersion,
  ).length
}

export function findTemplateForCredential(
  templates: BuiltinProviderTemplate[],
  credential: ProviderCredential,
): BuiltinProviderTemplate | null {
  const pluginId = credential.configuredFields?.pluginId
  const pluginVersion = credential.configuredFields?.pluginVersion
  if (!pluginId || !pluginVersion) return null
  return (
    templates.find((t) => t.pluginId === pluginId && t.pluginVersion === pluginVersion) || null
  )
}

/**
 * Credentials selectable for a preset. Built-in presets (exact plugin
 * identity) match enabled credentials by configuredFields.pluginId +
 * pluginVersion first; providerId fallback applies only to legacy records
 * without a configured plugin identity. Presets without plugin identity
 * (language/custom) keep the legacy adapter match. Video presets carry no
 * adapter, so they must never be filtered by adapter comparison.
 */
export function credentialsForPreset(
  credentials: ProviderCredential[],
  preset: Pick<ModelPreset, 'adapter' | 'providerId' | 'pluginId' | 'pluginVersion' | 'modelKind'> | null | undefined,
): ProviderCredential[] {
  if (!preset) return []
  const enabled = credentials.filter((c) => c.enabled)
  if (preset.pluginId && preset.pluginVersion) {
    const exact = enabled.filter(
      (c) =>
        c.configuredFields?.pluginId === preset.pluginId &&
        c.configuredFields?.pluginVersion === preset.pluginVersion,
    )
    if (exact.length > 0) return exact
    if (preset.providerId) {
      return enabled.filter(
        (c) => !(c.configuredFields?.pluginId && c.configuredFields?.pluginVersion) && c.providerId === preset.providerId,
      )
    }
    return []
  }
  if (preset.modelKind === 'language') {
    return enabled.filter((c) => c.adapter === preset.adapter && c.hasApiKey)
  }
  return enabled.filter((c) => c.adapter === preset.adapter)
}

/** Exact plugin key shown for built-in presets (e.g. `veo-video@1.0.0`). */
export function presetPluginKey(
  preset: Pick<ModelPreset, 'pluginId' | 'pluginVersion'> | null | undefined,
): string | null {
  if (!preset?.pluginId || !preset?.pluginVersion) return null
  return `${preset.pluginId}@${preset.pluginVersion}`
}

/** Active built-in image presets derive capabilities/defaults server-side. */
export function isActiveBuiltinImagePreset(
  preset: Pick<ModelPreset, 'modelKind' | 'pluginId' | 'pluginVersion'> | null | undefined,
): boolean {
  return (
    !!preset &&
    preset.modelKind === 'image' &&
    (ACTIVE_IMAGE_PLUGIN_IDS as readonly string[]).includes(preset.pluginId || '') &&
    preset.pluginVersion === ACTIVE_IMAGE_PLUGIN_VERSION
  )
}

/** Exact identity/schema payload for creating a credential from a template. */
export function buildTemplateCredentialInput(
  template: BuiltinProviderTemplate,
  secret: string | Record<string, unknown>,
  displayName?: string,
): ProviderCredentialInput {
  return {
    displayName: (displayName || '').trim() || template.displayName,
    adapter: template.adapter as ProviderCredentialInput['adapter'],
    providerId: template.providerId,
    pluginId: template.pluginId,
    pluginVersion: template.pluginVersion,
    schemaId: template.credential.schemaId,
    schemaVersion: template.credential.schemaVersion,
    baseUrl: template.baseUrl,
    credential: secret,
    enabled: true,
  }
}

export function parseServiceAccountJson(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = (raw || '').trim()
  if (!text) return { ok: false, error: '请粘贴 Google 服务账号 JSON' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: '服务账号 JSON 不是合法 JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '服务账号 JSON 必须是 JSON 对象' }
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.client_email !== 'string' || !record.client_email.trim()) {
    return { ok: false, error: '服务账号 JSON 缺少 client_email' }
  }
  if (typeof record.private_key !== 'string' || !record.private_key.trim()) {
    return { ok: false, error: '服务账号 JSON 缺少 private_key' }
  }
  return { ok: true, value: record }
}
