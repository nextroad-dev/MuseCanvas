import type { BuiltinProviderTemplate } from '@musecanvas/contracts'
import { globalProviderRegistry } from '@musecanvas/providers'
import { modelPresets, type ImageModelPreset, type ModelPreset, type VideoModelPreset } from './model-presets'

type PluginPreset = ImageModelPreset | VideoModelPreset

// Narrows a preset to one carrying an exact plugin identity.
function isPluginPreset(preset: ModelPreset, pluginId: string, pluginVersion: string): preset is PluginPreset {
  return 'pluginId' in preset && preset.pluginId === pluginId && 'pluginVersion' in preset && preset.pluginVersion === pluginVersion
}

type BuiltinCatalogSpec = {
  key: string
  pluginId: string
  pluginVersion: string
  providerId: string
  adapter: string
  displayName: string
  modality: 'image' | 'video'
  baseUrl: string
  credential: BuiltinProviderTemplate['credential']
}

// The four first-class built-in provider templates. Plugin keys, models, and
// preset membership resolve from the live registry/manifests below; only the
// display/credential metadata lives here.
const BUILTIN_CATALOG_SPECS: BuiltinCatalogSpec[] = [
  {
    key: 'openai-image',
    pluginId: 'openai-image',
    pluginVersion: '1.1.0',
    providerId: 'openai',
    adapter: 'openai',
    displayName: 'OpenAI Image',
    modality: 'image',
    baseUrl: 'https://api.openai.com',
    credential: {
      schemaId: 'legacy-api-key-v1',
      schemaVersion: 1,
      kind: 'api_key',
      label: 'OpenAI API Key',
      placeholder: 'sk-...',
      helpText: 'Official OpenAI API key with image generation access.',
    },
  },
  {
    key: 'seedream-image',
    pluginId: 'seedream-image',
    pluginVersion: '1.1.0',
    providerId: 'volcengine',
    adapter: 'seedream',
    displayName: 'Seedream Image',
    modality: 'image',
    baseUrl: 'https://ark.cn-beijing.volces.com',
    credential: {
      schemaId: 'legacy-api-key-v1',
      schemaVersion: 1,
      kind: 'api_key',
      label: 'Volcengine Ark API Key',
      placeholder: 'Ark API key',
      helpText: 'Volcengine Ark API key with Seedream model access.',
    },
  },
  {
    key: 'seedance-video',
    pluginId: 'seedance-video',
    pluginVersion: '1.0.0',
    providerId: 'volcengine',
    adapter: 'seedream',
    displayName: 'Seedance Video',
    modality: 'video',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    credential: {
      schemaId: 'legacy-api-key-v1',
      schemaVersion: 1,
      kind: 'api_key',
      label: 'Volcengine Ark API Key',
      placeholder: 'Ark API key',
      helpText: 'Volcengine Ark API key with Seedance model access.',
    },
  },
  {
    key: 'veo-video',
    pluginId: 'veo-video',
    pluginVersion: '1.0.0',
    providerId: 'google',
    adapter: 'veo',
    displayName: 'Veo Video',
    modality: 'video',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
    credential: {
      schemaId: 'json-v1',
      schemaVersion: 1,
      kind: 'google_service_account',
      label: 'Google Service Account JSON',
      placeholder: '{"type":"service_account","project_id":"...","client_email":"...","private_key":"..."}',
      helpText: 'Google Cloud service-account JSON with Vertex AI (Veo) access.',
    },
  },
]

// Registry-backed catalog of exactly the four current built-ins. Models come
// from the exact plugin manifests; presetIds come from presets carrying the
// exact plugin identity. Throws loudly when a listed preset references a
// vendor model absent from its manifest so stale presets fail fast instead
// of serving unresolvable templates.
export function buildBuiltinProviderTemplates(): BuiltinProviderTemplate[] {
  return BUILTIN_CATALOG_SPECS.map((spec) => {
    const plugin = globalProviderRegistry.get(spec.pluginId, spec.pluginVersion)
    const models = (plugin.manifest.models ?? []).map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
    }))
    const modelIds = new Set(models.map((model) => model.id))
    const presetIds = modelPresets
      .filter((preset) => isPluginPreset(preset, spec.pluginId, spec.pluginVersion))
      .map((preset) => {
        if (!modelIds.has(preset.vendorModelId)) {
          throw new Error(
            `Builtin provider template '${spec.key}' preset '${preset.id}' ` +
              `vendorModelId '${preset.vendorModelId}' is absent from plugin ` +
              `${spec.pluginId}@${spec.pluginVersion} manifest`,
          )
        }
        return preset.id
      })
    return {
      key: spec.key,
      pluginId: spec.pluginId,
      pluginVersion: spec.pluginVersion,
      providerId: spec.providerId,
      adapter: spec.adapter,
      displayName: spec.displayName,
      ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
      modality: spec.modality,
      baseUrl: spec.baseUrl,
      credential: spec.credential,
      presetIds,
      models,
    }
  })
}

// Catalog lookup for credential enforcement: returns the built-in template
// for an explicit plugin identity, or null for custom/legacy identities.
export function builtinProviderTemplateForPlugin(
  pluginId: string,
  pluginVersion: string,
): BuiltinProviderTemplate | null {
  const spec = BUILTIN_CATALOG_SPECS.find(
    (entry) => entry.pluginId === pluginId && entry.pluginVersion === pluginVersion,
  )
  if (!spec) return null
  const plugin = globalProviderRegistry.get(spec.pluginId, spec.pluginVersion)
  const models = (plugin.manifest.models ?? []).map((model) => ({
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
  }))
  const presetIds = modelPresets
    .filter((preset) => isPluginPreset(preset, spec.pluginId, spec.pluginVersion))
    .map((preset) => preset.id)
  return {
    key: spec.key,
    pluginId: spec.pluginId,
    pluginVersion: spec.pluginVersion,
    providerId: spec.providerId,
    adapter: spec.adapter,
    displayName: spec.displayName,
    ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
    modality: spec.modality,
    baseUrl: spec.baseUrl,
    credential: spec.credential,
    presetIds,
    models,
  }
}
