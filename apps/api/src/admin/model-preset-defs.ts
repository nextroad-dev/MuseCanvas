/**
 * Leaf module for the model-preset identity vocabulary.
 *
 * These types and the static `modelPresets` list are consumed by
 * `admin/model-presets.ts`, `modules/admin/plugin-catalog.ts` and
 * `shared/model-helpers.ts`. Keeping them here — with no imports back into the
 * API — breaks the three-way value cycle those modules used to form while
 * leaving their public surface unchanged (model-presets.ts re-exports them).
 */
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
 * Host-slug preset ids are pinned by `packages/database/migrations/*.sql`
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
