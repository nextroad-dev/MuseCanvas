import { globalProviderRegistry } from '../core/registry'
import { openAiImagePlugin } from './openai-image/index'
import { seedreamImagePlugin } from './seedream-image/index'
import { seedanceVideoPlugin } from './seedance-video/index'
import { veoVideoPlugin } from './veo-video/index'

// Register bundled static plugins idempotently
for (const plugin of [openAiImagePlugin, seedreamImagePlugin, seedanceVideoPlugin, veoVideoPlugin]) {
  if (!globalProviderRegistry.has(plugin.manifest.id, plugin.manifest.version)) {
    globalProviderRegistry.register(plugin)
  }
}

export * from '../core/index'
export * from './openai-image/index'
export * from './seedream-image/index'
export * from './seedance-video/index'
export * from './veo-video/index'
