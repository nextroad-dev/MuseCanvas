import { resolveCatalogPlugin } from '../modules/admin/plugin-catalog'
import type { JsonValue, MediaParameterProvenance, ModelCapabilities } from '@musecanvas/contracts'
import { validateModelCapabilities } from '@musecanvas/contracts'

// The preset identity vocabulary and the static list live in a leaf module so
// that this file, `plugin-catalog.ts` and `model-helpers.ts` no longer import
// each other. Re-exported here to keep every existing importer working.
export { modelPresets } from './model-preset-defs'
export type {
  ImageModelPreset,
  LanguageModelPreset,
  LanguageProtocol,
  MediaModelPreset,
  ModelPreset,
  ReasoningEffort,
  VideoModelPreset,
} from './model-preset-defs'

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
