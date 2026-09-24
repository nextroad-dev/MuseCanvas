import type {
  LanguageExecutionContext,
  LanguageProviderManifest,
  LanguageProviderPlugin,
  MediaPluginKey,
  ProviderConfig,
} from './types'
import { formatPluginKey } from './types'
import { NormalizedProviderError } from './errors'
import { DefaultSafeHttpClient } from './http'

export class LanguageProviderRegistry {
  private readonly plugins = new Map<MediaPluginKey, LanguageProviderPlugin>()

  /**
   * Register a plugin.
   * Deterministically throws on duplicate (pluginId, version).
   */
  register(plugin: LanguageProviderPlugin): void {
    const manifest = plugin.manifest
    if (!manifest?.id || !manifest?.version) {
      throw new Error('INVALID_PLUGIN_MANIFEST: plugin must have non-empty id and version')
    }

    const key = formatPluginKey(manifest.id, manifest.version)
    if (this.plugins.has(key)) {
      throw new Error(`DUPLICATE_PLUGIN_REGISTRATION: Plugin '${key}' is already registered`)
    }

    this.plugins.set(key, plugin)
  }

  /**
   * Get a registered plugin by exact (pluginId, version).
   * Deterministically throws when not found.
   */
  get(pluginId: string, version: string): LanguageProviderPlugin {
    const key = formatPluginKey(pluginId, version)
    const plugin = this.plugins.get(key)
    if (!plugin) {
      throw NormalizedProviderError.create(
        pluginId,
        version,
        'PROVIDER_NOT_CONFIGURED',
        `Plugin '${key}' is not registered`,
      )
    }
    return plugin
  }

  /**
   * Check if a plugin is registered.
   */
  has(pluginId: string, version: string): boolean {
    return this.plugins.has(formatPluginKey(pluginId, version))
  }

  /**
   * List all registered manifests.
   */
  listManifests(): LanguageProviderManifest[] {
    return Array.from(this.plugins.values()).map(p => p.manifest)
  }

  /**
   * Creates a LanguageExecutionContext with a bounded SafeHttpClient pinned to the
   * plugin allowlist. Unlike the media registry, config.baseUrl is deliberately NOT
   * appended to the allowlist: for future uploaded language plugins that widening is
   * an SSRF primitive. Callers must opt in explicitly via additionalAllowedHosts.
   */
  createExecutionContext(
    pluginId: string,
    version: string,
    options?: {
      config?: ProviderConfig
      fetchImpl?: typeof globalThis.fetch
      additionalAllowedHosts?: string[]
    },
  ): LanguageExecutionContext {
    const plugin = this.get(pluginId, version)
    const allowedHosts = [
      ...plugin.manifest.allowedHosts,
      ...(options?.additionalAllowedHosts || []),
    ]

    const http = new DefaultSafeHttpClient({
      pluginId,
      version,
      allowedHosts,
      fetchImpl: options?.fetchImpl,
    })

    return { pluginId, version, http }
  }
}
