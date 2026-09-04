import { globalProviderRegistry } from '../core/registry'
import { legacyOpenAiImagePlugin, openAiImagePlugin } from './openai-image/index'
import { legacySeedreamImagePlugin, seedreamImagePlugin } from './seedream-image/index'
import { seedanceVideoPlugin } from './seedance-video/index'
import { veoVideoPlugin } from './veo-video/index'

// Register bundled static plugins idempotently. Image plugins keep both the
// hardened active (1.1.0) and the legacy (1.0.0) registrations so
// already-pinned revisions keep resolving while new revisions use 1.1.0.
for (const plugin of [openAiImagePlugin, legacyOpenAiImagePlugin, seedreamImagePlugin, legacySeedreamImagePlugin, seedanceVideoPlugin, veoVideoPlugin]) {
  if (!globalProviderRegistry.has(plugin.manifest.id, plugin.manifest.version)) {
    globalProviderRegistry.register(plugin)
  }
}

export * from '../core/index'
export * from './openai-image/index'
export * from './seedream-image/index'
export * from './seedance-video/index'
export * from './veo-video/index'
