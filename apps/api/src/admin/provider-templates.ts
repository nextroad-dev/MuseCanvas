import type { BuiltinProviderTemplate } from '@musecanvas/contracts'
import { globalProviderRegistry } from '@musecanvas/providers'
import {
  installedPluginBaseUrl,
  presetsForCatalogPlugins,
  type CatalogPlugin,
} from '../modules/admin/plugin-catalog'
import { modelPresets, type ImageModelPreset, type ModelPreset, type VideoModelPreset } from './model-presets'

type PluginPreset = ImageModelPreset | VideoModelPreset

// Narrows a preset to one carrying an exact built-in plugin identity. Presets
// synthesized from an uploaded manifest can never collide here: uploading a key the
// static registry already owns is rejected (PLUGIN_ID_RESERVED), so an exact built-in
// spec key always belongs to a shipped preset.
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
//
// `installed` (active provider_plugins media manifests, resolved by the caller) is
// appended as extra templates; omitting it keeps the built-in listing unchanged.
export function buildBuiltinProviderTemplates(installed: CatalogPlugin[] = []): BuiltinProviderTemplate[] {
  return [...BUILTIN_CATALOG_SPECS.map(builtinTemplateForSpec), ...installedProviderTemplates(installed)]
}

function builtinTemplateForSpec(spec: BuiltinCatalogSpec): BuiltinProviderTemplate {
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
}

// One credential template per active installed media plugin, so an admin can create a
// credential bound to pluginId@pluginVersion. The API never loads the artifact, so
// everything here comes from the row's whitelisted manifest: the first exact
// allowedHost is the default endpoint, and the declared credential schema only selects
// which input the admin renders — reusing the two kinds the built-in catalog has.
function installedProviderTemplates(installed: CatalogPlugin[]): BuiltinProviderTemplate[] {
  const presets = presetsForCatalogPlugins(installed)
  const templates: BuiltinProviderTemplate[] = []
  for (const entry of installed) {
    const manifest = entry.manifest
    if (manifest.kind !== 'media') continue
    const schemaId = (manifest.credentialSchemas || [])[0] || 'legacy-api-key-v1'
    const kind: BuiltinProviderTemplate['credential']['kind'] = schemaId === 'legacy-api-key-v1' ? 'api_key' : 'google_service_account'
    templates.push({
      key: `installed:${manifest.id}@${manifest.version}`,
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      providerId: manifest.id,
      // No legacy adapter exists for an uploaded plugin; the plugin id keeps the field
      // populated while never colliding with openai/seedream/anthropic.
      adapter: manifest.id,
      displayName: manifest.displayName,
      ...(manifest.description ? { description: manifest.description } : {}),
      modality: manifest.modalities[0],
      baseUrl: installedPluginBaseUrl(manifest.allowedHosts || []),
      credential: {
        schemaId,
        schemaVersion: 1,
        kind,
        label: kind === 'api_key' ? `${manifest.displayName} API Key` : `${manifest.displayName} 凭据 JSON`,
        placeholder: kind === 'api_key' ? 'API key' : '{"...":"..."}',
        helpText: `${manifest.id}@${manifest.version} 声明的凭据格式（${schemaId}）。`,
      },
      presetIds: presets
        .filter(preset => 'pluginId' in preset && preset.pluginId === manifest.id && preset.pluginVersion === manifest.version)
        .map(preset => preset.id),
      models: (manifest.models ?? []).map(model => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
      })),
      source: 'installed',
    })
  }
  return templates
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
