import { resolveCatalogPlugin } from '../modules/admin/plugin-catalog'
import type { JsonValue, MediaParameterProvenance, ModelCapabilities } from '@musecanvas/contracts'
import { validateModelCapabilities } from '@musecanvas/contracts'

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'
export type LanguageProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages'

/**
 * A media preset is an **identity**, never a capability set.
 *
 * Until now these presets carried `sizes`, `qualityOptions`, `maxCount`,
 * `maxInputImages`, `modes`, `parameters`, `inputSlots` and `defaults` — a
 * hand-maintained transcription of what the OpenAI, Seedream, Seedance and Veo
 * plugins already declare in their own manifests. Two copies of one fact is the
 * bug: the preset list offered `1024x1024` to Seedream 4.5 while the vendor
 * band starts at 2K, the generic video preset offered 1-60s durations while
 * Seedance caps at 30, and nothing above `capabilities` could ever be trusted to
 * be the plugin's answer rather than the host's guess.
 *
 * The contract now lives in exactly one place — the plugin manifest — and
 * `resolvePresetCapabilities` is the only way to read it. A preset that cannot
 * resolve to a declared model declares nothing.
 */
export type MediaModelPreset = {
  id: string
  modelKind: 'image' | 'video'
  displayName: string
  /**
   * @deprecated Mirrors the legacy `model_configs.adapter` column, which is a
   * routing label from before plugins existed and has no descriptor equivalent.
   * Never a capability, and no new reader should consume it.
   */
  adapter?: string
  providerId: string
  pluginId: string
  pluginVersion: string
  vendorModelId: string
  baseUrl: string
  concurrencyLimit: number
}

export type ImageModelPreset = MediaModelPreset & { modelKind: 'image' }
export type VideoModelPreset = MediaModelPreset & { modelKind: 'video' }

export type LanguageModelPreset = {
  id: string
  modelKind: 'language'
  displayName: string
  /** @deprecated Legacy `model_configs.adapter` column; language models have no plugin manifest. */
  adapter: 'openai' | 'anthropic'
  vendorModelId: string
  baseUrl: string
  languageProtocol: LanguageProtocol
  maxOutputTokens: number
  temperature?: number
  reasoningEffort?: ReasoningEffort
  concurrencyLimit: number
}

export type ModelPreset = ImageModelPreset | VideoModelPreset | LanguageModelPreset

/**
 * Host-slug preset ids are pinned by `packages/database/src/migrate.ts`
 * eligibility checks (`WHERE preset_id = 'openai-gpt-image-2' …`) and by
 * `presetMatchesPersistedModel`, which compares a stored `preset_id` against the
 * row's plugin identity. Renaming one is a data migration, not a refactor, so
 * these ids are stable API: only their *contents* became identity-only.
 */
export const modelPresets: ModelPreset[] = [
  {
    modelKind: 'image',
    id: 'openai-gpt-image-2', displayName: 'GPT Image 2', adapter: 'openai', providerId: 'openai', pluginId: 'openai-image', pluginVersion: '1.1.0', vendorModelId: 'gpt-image-2', baseUrl: 'https://api.openai.com',
    concurrencyLimit: 1,
  },
  {
    modelKind: 'image',
    id: 'seedream-4-0', displayName: 'Seedream 4.0', adapter: 'seedream', providerId: 'volcengine', pluginId: 'seedream-image', pluginVersion: '1.1.0', vendorModelId: 'doubao-seedream-4-0-250828', baseUrl: 'https://ark.cn-beijing.volces.com',
    concurrencyLimit: 1,
  },
  {
    modelKind: 'image',
    id: 'seedream-4-5', displayName: 'Seedream 4.5', adapter: 'seedream', providerId: 'volcengine', pluginId: 'seedream-image', pluginVersion: '1.1.0', vendorModelId: 'doubao-seedream-4-5-251128', baseUrl: 'https://ark.cn-beijing.volces.com',
    concurrencyLimit: 1,
  },
  {
    modelKind: 'video',
    id: 'seedance-1-0', displayName: 'Seedance 2.0 Fast', providerId: 'volcengine', pluginId: 'seedance-video', pluginVersion: '1.0.0', vendorModelId: 'doubao-seedance-2-0-fast-260128', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    concurrencyLimit: 1,
  },
  {
    modelKind: 'video',
    id: 'veo-3-1', displayName: 'Veo 3.1', providerId: 'google', pluginId: 'veo-video', pluginVersion: '1.0.0', vendorModelId: 'veo-3.1-generate-001', baseUrl: 'https://us-central1-aiplatform.googleapis.com',
    concurrencyLimit: 1,
  },
  {
    id: 'openai-gpt-5-5', modelKind: 'language', displayName: 'GPT-5.5', adapter: 'openai', vendorModelId: 'gpt-5.5', baseUrl: 'https://api.openai.com',
    languageProtocol: 'openai_responses', maxOutputTokens: 25000, reasoningEffort: 'medium', concurrencyLimit: 1,
  },
  {
    id: 'openai-gpt-5-4', modelKind: 'language', displayName: 'GPT-5.4', adapter: 'openai', vendorModelId: 'gpt-5.4', baseUrl: 'https://api.openai.com',
    languageProtocol: 'openai_responses', maxOutputTokens: 25000, reasoningEffort: 'medium', concurrencyLimit: 1,
  },
]

export type ResolvedPresetCapabilities = {
  /**
   * The manifest's own contract, rebuilt through `validateModelCapabilities` so
   * nothing outside the known descriptor grammar survives into a revision.
   * Empty arrays plus `declaredBy: 'undeclared'` when the model declares nothing.
   */
  capabilities: ModelCapabilities
  /** Starting values as declared next to the contract; never invented here. */
  defaults: Record<string, JsonValue>
  /** Vendor-retired but still servable. */
  deprecated: boolean
  deprecationNote?: string
  /**
   * Why a declaration was refused. Present only when the manifest *did* declare
   * something and that something was malformed: an absent contract is not an
   * error, it is an absence, and the admin has to be able to tell them apart.
   */
  findings?: Array<{ rule: string; message: string }>
}

/** The one answer a model with no declaration gets: nothing, and a label saying so. */
function undeclaredContract(): ModelCapabilities {
  return {
    modes: [],
    parameters: [],
    inputSlots: [],
    maxCount: 0,
    supportedMediaKinds: [],
    declaredBy: 'undeclared',
  }
}

/**
 * The plugin manifest is the only source of a model's parameter contract, so
 * that is the only thing this lookup reads.
 *
 * `declaredBy` is stamped `plugin-manifest` when the model declared a contract
 * without saying where it came from — the manifest *is* the source, so stating
 * it is a fact rather than a guess. Anything the manifest does not say stays
 * unsaid: an unknown `pluginId`, a plugin the catalog has not activated, a
 * non-media manifest, a vendor model the manifest does not list, and a model
 * with no `capabilities` block all resolve to `undeclared` with empty arrays.
 *
 * A declaration that exists but is structurally illegal (an unknown descriptor
 * type, a preset outside its own geometry band, a default nobody offers) also
 * resolves to `undeclared`, but carries `findings` so the write path can refuse
 * the save with the plugin's own error instead of quietly persisting nothing.
 */
export async function resolvePresetCapabilities(
  pluginId: string,
  pluginVersion: string,
  vendorModelId: string,
): Promise<ResolvedPresetCapabilities> {
  const catalog = await resolveCatalogPlugin(pluginId, pluginVersion)
  if (!catalog || catalog.manifest.kind !== 'media') {
    return { capabilities: undeclaredContract(), defaults: {}, deprecated: false }
  }
  const model = (catalog.manifest.models ?? []).find(entry => entry.id === vendorModelId)
  const declared = model?.capabilities
  if (!model || !declared) {
    return { capabilities: undeclaredContract(), defaults: {}, deprecated: false }
  }
  const provenance: MediaParameterProvenance = declared.declaredBy ?? 'plugin-manifest'
  const validated = validateModelCapabilities({
    ...declared,
    declaredBy: provenance,
    ...(typeof model.deprecated === 'boolean' ? { deprecated: model.deprecated } : {}),
    ...(typeof model.deprecationNote === 'string' ? { deprecationNote: model.deprecationNote } : {}),
  })
  if (!validated.ok || !validated.capabilities) {
    return {
      capabilities: { ...undeclaredContract(), declaredBy: 'undeclared' },
      defaults: {},
      deprecated: model.deprecated === true,
      ...(typeof model.deprecationNote === 'string' ? { deprecationNote: model.deprecationNote } : {}),
      findings: validated.findings,
    }
  }
  return {
    capabilities: validated.capabilities,
    defaults: { ...(model.defaults ?? {}) },
    deprecated: model.deprecated === true,
    ...(typeof model.deprecationNote === 'string' ? { deprecationNote: model.deprecationNote } : {}),
  }
}
