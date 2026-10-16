import {
  credentialServesPlugin,
  decodeCredential,
  globalPluginRegistry,
  pluginCredentialSpec,
  resolveCredentialBaseUrl,
  type AnyProviderManifest,
  type DecodedCredential,
} from '@musecanvas/providers'
import { listCatalogManifests, resolveCatalogPlugin, type CatalogPlugin } from '../plugin-catalog'

/**
 * Credential rules, all read from plugin manifests. The API never imports uploaded
 * plugin code, so for those the manifest's declared contract is the whole check;
 * built-in plugins additionally run their own `validateConfig` on the secret.
 */

export type CredentialTarget = {
  providerId: string
  schemaId: string
  schemaVersion: number
  baseUrl: string | null
  plugin?: { pluginId: string; pluginVersion: string }
}

export type CredentialCheck<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

const failure = (code: string, message: string) => ({ ok: false as const, code, message })

/** Every catalog plugin consuming this provider account; built-ins first, the database only if needed. */
async function pluginsForProvider(providerId: string): Promise<CatalogPlugin[]> {
  const builtins = globalPluginRegistry.listManifests()
    .filter(manifest => pluginCredentialSpec(manifest).providerId === providerId)
    .map(manifest => ({ source: 'builtin' as const, manifest }))
  if (builtins.length) return builtins
  return (await listCatalogManifests()).filter(entry => pluginCredentialSpec(entry.manifest).providerId === providerId)
}

/**
 * Settles provider, schema and endpoint for a credential write, and checks the
 * secret when one is supplied.
 *
 * With a template plugin, that plugin's contract is applied in full: its provider
 * account, one of its schemas, its endpoint policy (an empty endpoint becomes its
 * default) and, for a built-in, its own `validateConfig`. Without one, the provider
 * must be consumed by some catalog plugin, the schema must be decodable by one of
 * them, and an endpoint must satisfy at least one of their policies.
 */
export async function resolveCredentialTarget(state: {
  providerId?: string
  plugin?: { pluginId: string; pluginVersion: string }
  schemaId?: string
  schemaVersion?: number
  baseUrl?: string | null
  secret?: string
}): Promise<CredentialCheck<CredentialTarget>> {
  let candidates: CatalogPlugin[]
  let providerId: string
  if (state.plugin) {
    const catalog = await resolveCatalogPlugin(state.plugin.pluginId, state.plugin.pluginVersion)
    if (!catalog) return failure('INVALID_PLUGIN', '供应商插件不存在或版本不受支持')
    const declared = pluginCredentialSpec(catalog.manifest).providerId
    if (state.providerId && state.providerId !== declared) {
      return failure('INVALID_INPUT', `该插件凭据的供应商类型必须为 ${declared}`)
    }
    providerId = declared
    candidates = [catalog]
  } else {
    if (!state.providerId) return failure('INVALID_INPUT', '供应商类型无效')
    providerId = state.providerId
    candidates = await pluginsForProvider(providerId)
    if (!candidates.length) return failure('INVALID_INPUT', '供应商类型无效')
  }

  const schemaId = state.schemaId ?? pluginCredentialSpec(candidates[0].manifest).schemaId
  const servable = candidates.filter(entry => credentialServesPlugin(entry.manifest, { provider_id: providerId, schema_id: schemaId }))
  if (!servable.length) return failure('INVALID_INPUT', '该插件不支持此凭据 schema')

  let baseUrl: string | null = state.baseUrl ?? null
  if (state.plugin) {
    const resolved = resolveCredentialBaseUrl(servable[0].manifest, baseUrl)
    if (!resolved.ok) return failure('INVALID_BASE_URL', 'Base URL 不符合该插件的服务端点策略')
    baseUrl = resolved.baseUrl ?? null
  } else if (baseUrl && !servable.some(entry => resolveCredentialBaseUrl(entry.manifest, baseUrl).ok)) {
    return failure('INVALID_BASE_URL', 'Base URL 不符合该供应商任何插件的服务端点策略')
  }

  if (state.secret !== undefined) {
    let decoded: DecodedCredential
    try {
      decoded = decodeCredential(state.secret, schemaId, state.plugin?.pluginId, state.plugin?.pluginVersion)
    } catch (error) {
      console.error('credential decode failed', error instanceof Error ? error.message : error)
      return failure('INVALID_CREDENTIAL', '凭据内容无法解析')
    }
    // Only a built-in's code is available here; an uploaded plugin's validateConfig
    // runs in the worker when it is first used.
    if (state.plugin && servable[0].source === 'builtin') {
      const { pluginId, pluginVersion } = state.plugin
      const plugin = globalPluginRegistry.kindOf(pluginId, pluginVersion) === 'language'
        ? globalPluginRegistry.getLanguage(pluginId, pluginVersion)
        : globalPluginRegistry.getMedia(pluginId, pluginVersion)
      try {
        await plugin.validateConfig({ baseUrl: baseUrl ?? undefined, credential: decoded })
      } catch (error) {
        console.error('credential plugin validation failed', error instanceof Error ? error.message : error)
        return failure('INVALID_CREDENTIAL', '凭据未通过插件校验')
      }
    }
  }

  return {
    ok: true,
    value: {
      providerId,
      schemaId,
      schemaVersion: state.schemaVersion ?? 1,
      baseUrl,
      ...(state.plugin ? { plugin: state.plugin } : {}),
    },
  }
}

/**
 * Whether a stored credential may back a model on this plugin: the same provider
 * account, a schema the plugin decodes, and an endpoint inside the plugin's policy
 * (a credential's base URL overrides the model's at runtime, so it must qualify
 * on its own). Returns the reason when it may not.
 */
export function credentialBindingError(
  manifest: AnyProviderManifest,
  credential: { provider_id?: unknown; schema_id?: unknown; base_url?: unknown },
): { code: string; message: string } | null {
  if (!credentialServesPlugin(manifest, credential)) {
    return { code: 'INVALID_INPUT', message: '供应商凭据与模型插件不匹配' }
  }
  const baseUrl = typeof credential.base_url === 'string' ? credential.base_url : null
  if (!resolveCredentialBaseUrl(manifest, baseUrl).ok) {
    return { code: 'INVALID_BASE_URL', message: '该供应商凭据的 Base URL 不符合模型插件的服务端点策略' }
  }
  return null
}
