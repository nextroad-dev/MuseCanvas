import type {
  LanguageExecutionContext,
  LanguageProviderManifest,
  LanguageProviderPlugin,
  MediaProviderManifest,
  MediaProviderPlugin,
  ProviderConfig,
  ProviderPluginKind,
} from './types'
import { formatPluginKey } from './types'
import { MediaProviderRegistry, globalProviderRegistry } from './registry'
import { LanguageProviderRegistry } from './language-registry'

/**
 * Unified facade over one media registry and one language registry. Both kernels
 * share a single `id@version` namespace via formatPluginKey, so a key claimed by
 * one kind is deterministically rejected by the other.
 */
export class PluginRegistry {
  private readonly media: MediaProviderRegistry
  private readonly language: LanguageProviderRegistry

  constructor(
    media: MediaProviderRegistry = globalProviderRegistry,
    language: LanguageProviderRegistry = new LanguageProviderRegistry(),
  ) {
    this.media = media
    this.language = language
  }

  registerMedia(plugin: MediaProviderPlugin): void {
    const manifest = plugin.manifest
    if (!manifest?.id || !manifest?.version) {
      throw new Error('INVALID_PLUGIN_MANIFEST: plugin must have non-empty id and version')
    }
    const key = formatPluginKey(manifest.id, manifest.version)
    if (this.language.has(manifest.id, manifest.version)) {
      throw new Error(`DUPLICATE_PLUGIN_REGISTRATION: Plugin '${key}' is already registered as a language plugin`)
    }
    this.media.register(plugin)
  }

  registerLanguage(plugin: LanguageProviderPlugin): void {
    const manifest = plugin.manifest
    if (!manifest?.id || !manifest?.version) {
      throw new Error('INVALID_PLUGIN_MANIFEST: plugin must have non-empty id and version')
    }
    const key = formatPluginKey(manifest.id, manifest.version)
    if (this.media.has(manifest.id, manifest.version)) {
      throw new Error(`DUPLICATE_PLUGIN_REGISTRATION: Plugin '${key}' is already registered as a media plugin`)
    }
    this.language.register(plugin)
  }

  getMedia(pluginId: string, version: string): MediaProviderPlugin {
    return this.media.get(pluginId, version)
  }

  getLanguage(pluginId: string, version: string): LanguageProviderPlugin {
    return this.language.get(pluginId, version)
  }

  has(pluginId: string, version: string): boolean {
    return this.media.has(pluginId, version) || this.language.has(pluginId, version)
  }

  kindOf(pluginId: string, version: string): ProviderPluginKind | undefined {
    if (this.media.has(pluginId, version)) return 'media'
    if (this.language.has(pluginId, version)) return 'language'
    return undefined
  }

  /**
   * Delegated so the language registry stays the only place that builds a
   * LanguageExecutionContext (and therefore the only place that pins its allowlist).
   */
  createLanguageExecutionContext(
    pluginId: string,
    version: string,
    options?: {
      config?: ProviderConfig
      fetchImpl?: typeof globalThis.fetch
      additionalAllowedHosts?: string[]
    },
  ): LanguageExecutionContext {
    return this.language.createExecutionContext(pluginId, version, options)
  }

  listManifests(): (MediaProviderManifest | LanguageProviderManifest)[] {
    return [...this.media.listManifests(), ...this.language.listManifests()]
  }
}

/**
 * Global facade. Wraps the shared media registry (so the built-in media plugins stay
 * resolvable) and an initially empty language registry.
 */
export const globalPluginRegistry = new PluginRegistry()
