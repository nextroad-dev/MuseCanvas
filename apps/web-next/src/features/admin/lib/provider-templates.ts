// Pure helpers for built-in media provider templates (browser-safe, no DOM).
// Keeps template/credential matching and credential identity payloads testable
// without mounting views.
import type {
  BuiltinProviderTemplate,
  ModelPreset,
  ProviderCredential,
  ProviderCredentialInput,
} from '@/shared/types'

/**
 * Legacy (plugin-less) adapter options, split by the page that creates them.
 * The API only accepts these three adapter strings without a plugin identity
 * (see `LEGACY_ADAPTERS` in `apps/api/src/modules/admin/provider-credentials.ts`).
 */
export const LEGACY_ADAPTER_OPTIONS: Record<
  'media' | 'language',
  readonly { value: string; label: string }[]
> = {
  media: [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'seedream', label: 'Seedream (火山引擎)' },
  ],
  language: [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'anthropic', label: 'Anthropic' },
  ],
}

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
    // Language presets have no plugin identity, so plugin-bound media
    // credentials (which merely share an adapter string) are never candidates.
    return enabled.filter(
      (c) => c.adapter === preset.adapter && c.hasApiKey && !isPluginBoundCredential(c),
    )
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

/** Exact plugin identity a credential is bound to, or null when plugin-less. */
export function credentialPluginKey(
  credential: Pick<ProviderCredential, 'configuredFields'>,
): string | null {
  const pluginId = credential.configuredFields?.pluginId
  const pluginVersion = credential.configuredFields?.pluginVersion
  if (typeof pluginId !== 'string' || !pluginId) return null
  if (typeof pluginVersion !== 'string' || !pluginVersion) return null
  return `${pluginId}@${pluginVersion}`
}

/**
 * Media credentials are the plugin-bound ones: only they can pass the provider
 * plugin probe in `testProviderCredential`.
 */
export function isPluginBoundCredential(
  credential: Pick<ProviderCredential, 'configuredFields'>,
): boolean {
  return credentialPluginKey(credential) !== null
}

/**
 * Language / custom credentials carry no plugin identity (`adapter` + API key +
 * base URL). This is the only shape a language preset can bind, because
 * `credentialsForPreset` matches language presets by adapter, never by plugin.
 */
export function isCustomCredential(
  credential: Pick<ProviderCredential, 'configuredFields'>,
): boolean {
  return !isPluginBoundCredential(credential)
}

/** Exact identity/schema payload for creating a credential from a template. */
export function buildTemplateCredentialInput(
  template: BuiltinProviderTemplate,
  secret: string | Record<string, unknown>,
  displayName?: string,
): ProviderCredentialInput {
  return {
    displayName: (displayName || '').trim() || template.displayName,
    adapter: template.adapter,
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
