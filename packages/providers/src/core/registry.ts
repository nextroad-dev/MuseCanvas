import type {
  ExecutionContext,
  MediaPluginKey,
  MediaProviderManifest,
  MediaProviderPlugin,
  OutputDescriptor,
  ProviderConfig,
} from './types'
import { formatPluginKey } from './types'
import { NormalizedProviderError } from './errors'
import { DefaultSafeHttpClient } from './http'
import { readBoundedOutput } from './output-reader'

export class MediaProviderRegistry {
  private readonly plugins = new Map<MediaPluginKey, MediaProviderPlugin>()

  /**
   * Register a plugin.
   * Deterministically throws on duplicate (pluginId, version).
   */
  register(plugin: MediaProviderPlugin): void {
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
  get(pluginId: string, version: string): MediaProviderPlugin {
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
  listManifests(): MediaProviderManifest[] {
    return Array.from(this.plugins.values()).map(p => p.manifest)
  }

  /**
   * Creates an ExecutionContext for a specific plugin, injecting its bounded SafeHttpClient
   * with configured allowedHosts, plus bounded readOutput helper.
   */
  createExecutionContext(
    pluginId: string,
    version: string,
    options?: {
      config?: ProviderConfig
      fetchImpl?: typeof globalThis.fetch
      additionalAllowedHosts?: string[]
    },
  ): ExecutionContext {
    const plugin = this.get(pluginId, version)
    const allowedHosts = [
      ...plugin.manifest.allowedHosts,
      ...(options?.additionalAllowedHosts || []),
    ]

    // If config specifies a custom baseUrl, allow its hostname if valid
    if (options?.config?.baseUrl) {
      try {
        const u = new URL(options.config.baseUrl)
        if (!allowedHosts.includes(u.hostname)) {
          allowedHosts.push(u.hostname)
        }
      } catch {
        // BaseUrl validation will fail in validateConfig or SafeHttpClient
      }
    }

    const http = new DefaultSafeHttpClient({
      pluginId,
      version,
      allowedHosts,
      fetchImpl: options?.fetchImpl,
    })

    const context: ExecutionContext = {
      pluginId,
      version,
      http,
      readOutput: (descriptor: OutputDescriptor, readOptions) => {
        const outputAllowedHosts = [
          ...allowedHosts,
          ...(readOptions?.allowedHosts || []),
        ]
        return readBoundedOutput(
          descriptor,
          http,
          {
            ...readOptions,
            allowedHosts: outputAllowedHosts,
          },
          pluginId,
          version,
        )
      },
    }

    return context
  }
}

/**
 * Global static registry instance.
 */
export const globalProviderRegistry = new MediaProviderRegistry()
