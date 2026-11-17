import { enumOptionValues, validateModelCapabilities } from '@musecanvas/contracts'
import type {
  GenerationMode, InputSlotDescriptor, MediaKind, MediaParameterProvenance,
  ModelCapabilities, ModelCapabilityFlags, ParameterCrossFieldConstraint, ParameterDescriptor,
} from '@musecanvas/contracts'

function parseJsonField(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * The capability contract a model row carries, already rebuilt through
 * `validateModelCapabilities` and therefore safe to hand to a browser.
 *
 * `declaredBy` is never inferred from convenience: the only three answers are
 * what the pinned revision said, what the host wrote into a legacy revision, and
 * `undeclared` for a row that says nothing.
 */
export type ModelCapabilitySnapshot = {
  modes: GenerationMode[]
  parameters: ParameterDescriptor[]
  inputSlots: InputSlotDescriptor[]
  maxCount: number
  supportedMediaKinds: MediaKind[]
  flags?: ModelCapabilityFlags
  crossFieldConstraints?: ParameterCrossFieldConstraint[]
  declaredBy: MediaParameterProvenance
  deprecated?: boolean
  deprecationNote?: string
}

/** Fresh arrays every call: the empty contract is never a shared mutable object. */
function undeclaredCapabilities(): ModelCapabilitySnapshot {
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
 * Reads the model's contract out of the pinned revision snapshot.
 *
 * There is no second source any more. The former legacy branch here rebuilt
 * `size` / `quality` / `count` descriptors from the flat `sizes`,
 * `quality_options`, `max_count` and `max_input_images` columns, so a row could
 * advertise a parameter no plugin ever accepted — `quality: 'ultra'` on a model
 * with no quality token, a `size` the vendor had dropped, an input slot the
 * plugin's own endpoint has never supported — and nothing downstream could tell
 * an advertised value from a guessed one. Those columns are now *derived* from
 * this function's result, never the other way round.
 *
 * A snapshot that fails structural validation degrades to `undeclared` rather
 * than being served: the alternative is shipping a descriptor the browser cannot
 * validate against, which is how illegal values reached a provider and failed
 * there with an opaque error.
 */
export function capabilitiesFromRow(row: Record<string, unknown>): ModelCapabilitySnapshot {
  const snapshot = parseJsonField(row.capabilities)
  if (!snapshot) return undeclaredCapabilities()
  const validated = validateModelCapabilities(snapshot)
  if (!validated.ok || !validated.capabilities) return undeclaredCapabilities()
  const capabilities = validated.capabilities
  return {
    modes: capabilities.modes,
    parameters: capabilities.parameters,
    inputSlots: capabilities.inputSlots,
    maxCount: typeof capabilities.maxCount === 'number' ? capabilities.maxCount : 0,
    supportedMediaKinds: capabilities.supportedMediaKinds ?? [],
    ...(capabilities.flags ? { flags: capabilities.flags } : {}),
    ...(capabilities.crossFieldConstraints
      ? { crossFieldConstraints: capabilities.crossFieldConstraints }
      : {}),
    // A revision written before provenance existed was assembled by the host from
    // its own columns, so `host-synthesized` is the truthful label for it. It is
    // still a declared contract, which is what the submit gate keys on.
    declaredBy: capabilities.declaredBy ?? 'host-synthesized',
    ...(typeof capabilities.deprecated === 'boolean' ? { deprecated: capabilities.deprecated } : {}),
    ...(typeof capabilities.deprecationNote === 'string' ? { deprecationNote: capabilities.deprecationNote } : {}),
  }
}

/**
 * @deprecated These are the flat `model_configs` columns, kept only because the
 * columns exist and `jobDto` still echoes the per-job copies. Every one of them is
 * *derived* from the descriptors above rather than read from the row, so they can
 * never disagree with what the model declares. No new reader may consume them:
 * `sizes` is the preset/option list of the `size` descriptor, `qualityOptions` the
 * `quality` descriptor's options, and `maxInputImages` the widest image-accepting
 * input slot.
 */
export function legacyColumnsFromCapabilities(capabilities: Pick<ModelCapabilities, 'parameters' | 'inputSlots' | 'maxCount'>): {
  sizes: string[]
  qualityOptions: string[]
  maxCount: number
  maxInputImages: number
} {
  const valuesFor = (parameterName: string): string[] => {
    const descriptor = capabilities.parameters.find((entry) => entry.name === parameterName)
    if (!descriptor) return []
    if (descriptor.type === 'image-size') return descriptor.presets.map((preset) => preset.value)
    if (descriptor.type === 'enum') return enumOptionValues(descriptor.options)
    return []
  }
  const maxInputImages = capabilities.inputSlots.reduce((widest, slot) => (
    slot.allowedMediaKinds.includes('image') ? Math.max(widest, slot.maxCount) : widest
  ), 0)
  return {
    sizes: valuesFor('size'),
    qualityOptions: valuesFor('quality'),
    maxCount: typeof capabilities.maxCount === 'number' ? capabilities.maxCount : 0,
    maxInputImages,
  }
}

export function defaultsFromRow(row: Record<string, unknown>): Record<string, unknown> {
  return parseJsonField(row.defaults) || {}
}

