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
 * Provider accounts a credential can be created for without a plugin template,
 * split by the page that creates them. Values are provider ids (Seedream's Ark
 * account lives under 'volcengine', shared with Seedance).
 */
export const CUSTOM_PROVIDER_OPTIONS: Record<
  'media' | 'language',
  readonly { value: string; label: string }[]
> = {
  media: [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'volcengine', label: 'Seedream（火山引擎）' },
  ],
  language: [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'anthropic', label: 'Anthropic' },
  ],
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Mirrors the API's binding rule (`credentialBindingError`) as far as the browser
 * can see it: same provider account, and for a `fixed` endpoint policy no foreign
 * host. Allowlists are not shipped to the browser, so `allowlisted` endpoints are
 * left for the API to judge on save.
 */
export function credentialFitsTemplate(
  credential: Pick<ProviderCredential, 'providerId' | 'baseUrl'>,
  template: Pick<BuiltinProviderTemplate, 'providerId' | 'baseUrl' | 'credential'>,
): boolean {
  if (credential.providerId !== template.providerId) return false
  if (template.credential.baseUrlPolicy !== 'fixed' || !credential.baseUrl) return true
  return hostOf(credential.baseUrl) === hostOf(template.baseUrl)
}

/** Credentials that can back models of this template's plugin. */
export function templateConfiguredCount(
  credentials: ProviderCredential[],
  template: BuiltinProviderTemplate,
): number {
  return credentials.filter((c) => credentialFitsTemplate(c, template)).length
}

/**
 * Credentials selectable for a preset. A credential belongs to a provider
 * account, not to a plugin version, so plugin presets match by provider (plus
 * the template's endpoint policy when the template is known). Language presets
 * match by the protocol vendor among the plugin-less credentials.
 */
export function credentialsForPreset(
  credentials: ProviderCredential[],
  preset: Pick<ModelPreset, 'adapter' | 'providerId' | 'pluginId' | 'pluginVersion' | 'modelKind'> | null | undefined,
  template?: Pick<BuiltinProviderTemplate, 'providerId' | 'baseUrl' | 'credential'> | null,
): ProviderCredential[] {
  if (!preset) return []
  const enabled = credentials.filter((c) => c.enabled && (c.hasCredential ?? c.hasApiKey))
  if (preset.pluginId && preset.pluginVersion) {
    if (template) return enabled.filter((c) => credentialFitsTemplate(c, template))
    return preset.providerId ? enabled.filter((c) => c.providerId === preset.providerId) : []
  }
  if (preset.modelKind === 'language') {
    // Plugin-bound media credentials are never offered here, even when they share
    // the provider account: the language page manages its own keys.
    return enabled.filter(
      (c) => (c.providerId ?? c.adapter) === preset.adapter && !isPluginBoundCredential(c),
    )
  }
  return []
}

/** Exact plugin key shown for built-in presets (e.g. `veo-video@1.0.0`). */
export function presetPluginKey(
  preset: Pick<ModelPreset, 'pluginId' | 'pluginVersion'> | null | undefined,
): string | null {
  if (!preset?.pluginId || !preset?.pluginVersion) return null
  return `${preset.pluginId}@${preset.pluginVersion}`
}

/** The template plugin a credential was created from, or null when created without one. */
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
 * Media credentials are the ones created from a plugin template; that template is
 * also what an unlinked credential's connectivity test probes.
 */
export function isPluginBoundCredential(
  credential: Pick<ProviderCredential, 'configuredFields'>,
): boolean {
  return credentialPluginKey(credential) !== null
}

/**
 * Language / custom credentials were created without a plugin template (provider
 * account + API key + optional endpoint). The language page lists exactly these,
 * and `credentialsForPreset` offers only these to language presets.
 */
export function isCustomCredential(
  credential: Pick<ProviderCredential, 'configuredFields'>,
): boolean {
  return !isPluginBoundCredential(credential)
}

/**
 * Payload for creating a credential from a template. The template's plugin is
 * named so the API validates against its declared contract; the endpoint is left
 * out so the plugin's declared default applies.
 */
export function buildTemplateCredentialInput(
  template: BuiltinProviderTemplate,
  secret: string | Record<string, unknown>,
  displayName?: string,
): ProviderCredentialInput {
  return {
    displayName: (displayName || '').trim() || template.displayName,
    providerId: template.providerId,
    pluginId: template.pluginId,
    pluginVersion: template.pluginVersion,
    schemaId: template.credential.schemaId,
    schemaVersion: template.credential.schemaVersion,
    secret,
    enabled: true,
  }
}

/** A pasted JSON credential must be one JSON object; the plugin checks its fields server-side. */
export function parseJsonSecret(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const text = (raw || '').trim()
  if (!text) return { ok: false, error: '请粘贴凭据 JSON' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: '凭据不是合法 JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '凭据 JSON 必须是 JSON 对象' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
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
