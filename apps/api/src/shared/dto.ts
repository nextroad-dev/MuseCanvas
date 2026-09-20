import { signedAssetUrl } from './services'
import { enumOptionValues, validateModelCapabilities } from '@musecanvas/contracts'
import type {
  GenerationMode,
  InputSlotDescriptor,
  JsonValue,
  MediaKind,
  MediaParameterProvenance,
  ModelCapabilities,
  ModelCapabilityFlags,
  ParameterCrossFieldConstraint,
  ParameterDescriptor,
  PublicModelDto,
} from '@musecanvas/contracts'

export const userDto = (row: Record<string, unknown>) => ({
  id: row.id as string,
  email: row.email as string,
  role: row.role as string,
  status: row.status as string,
  createdAt: new Date(row.created_at as string | number | Date).toISOString(),
})

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

function parseDescriptorArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[]
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
    } catch {
      return []
    }
  }
  return []
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

export const publicModelDto = (row: Record<string, unknown>): PublicModelDto => {
  // `model_configs.model_kind` also carries 'language'; this DTO is only ever
  // served for the media kinds `GET /api/models` selects.
  const modelKind = ((row.media_kind as string) || (row.model_kind as string) || 'image') as MediaKind
  const capabilities = capabilitiesFromRow(row)
  const defaults = defaultsFromRow(row) as Record<string, JsonValue>
  const legacy = legacyColumnsFromCapabilities(capabilities)
  return {
    id: row.id as string,
    displayName: row.display_name as string,
    modelKind,
    providerId: (row.provider_id as string) || undefined,
    pluginId: (row.plugin_id as string) || undefined,
    pluginVersion: (row.plugin_version as string) || '1.0.0',
    modes: capabilities.modes,
    parameters: capabilities.parameters,
    inputSlots: capabilities.inputSlots,
    defaults,
    maxCount: capabilities.maxCount,
    maxInputImages: legacy.maxInputImages,
    supportedMediaKinds: capabilities.supportedMediaKinds,
    ...(capabilities.flags ? { flags: capabilities.flags } : {}),
    ...(capabilities.crossFieldConstraints ? { crossFieldConstraints: capabilities.crossFieldConstraints } : {}),
    declaredBy: capabilities.declaredBy,
    ...(capabilities.deprecated !== undefined ? { deprecated: capabilities.deprecated } : {}),
    ...(capabilities.deprecationNote !== undefined ? { deprecationNote: capabilities.deprecationNote } : {}),
    /** @deprecated Legacy `model_configs.adapter` routing column. */
    adapter: (row.adapter as string) || '',
    /** @deprecated Mirror of the `size` descriptor; read `parameters`. */
    sizes: legacy.sizes,
    /** @deprecated Mirror of the `quality` descriptor; read `parameters`. */
    qualityOptions: legacy.qualityOptions,
    enabled: Boolean(row.enabled),
    sortOrder: Number(row.sort_order || 0),
  }
}

export const modelDto = (row: Record<string, unknown>) => ({
  ...publicModelDto(row),
  presetId: (row.preset_id as string) || undefined,
  modelKind: ((row.media_kind as string) || (row.model_kind as string) || 'image') as string,
  languageProtocol: (row.language_protocol as string) || undefined,
  maxOutputTokens: row.max_output_tokens ? Number(row.max_output_tokens) : undefined,
  temperature: row.temperature === null || row.temperature === undefined ? undefined : Number(row.temperature),
  reasoningEffort: (row.reasoning_effort as string) || undefined,
  vendorModelId: row.vendor_model_id as string,
  baseUrl: (row.base_url as string) || '',
  concurrencyLimit: Number(row.concurrency_limit || 0),
  watermark: Boolean(row.watermark),
  providerCredentialId: (row.provider_credential_id as string) || undefined,
  providerCredentialName: (row.provider_credential_name as string) || undefined,
  revision: row.revision !== undefined && row.revision !== null ? Number(row.revision) : undefined,
  latestRevisionId: (row.latest_revision_id as string) || (row.model_revision_id as string) || undefined,
})

type OutputRow = Record<string, unknown>

function outputDto(output: OutputRow) {
  const mediaKind = ((output.media_kind as string) || 'image') as 'image' | 'video'
  const base = {
    assetId: output.asset_id as string,
    id: output.asset_id as string,
    url: output.signed_url as string,
    downloadUrl: (output.signed_url as string) || undefined,
  }
  if (mediaKind === 'video') {
    return {
      ...base,
      mediaKind: 'video' as const,
      metadata: {
        width: output.width !== null && output.width !== undefined ? Number(output.width) : undefined,
        height: output.height !== null && output.height !== undefined ? Number(output.height) : undefined,
        durationSeconds: output.duration_seconds !== null && output.duration_seconds !== undefined
          ? Number(output.duration_seconds)
          : undefined,
        fps: output.fps !== null && output.fps !== undefined ? Number(output.fps) : undefined,
        codec: (output.codec as string) || undefined,
        hasAudio: typeof output.has_audio === 'boolean' ? output.has_audio as boolean : undefined,
        format: (output.mime_type as string) || undefined,
        sizeBytes: output.size_bytes !== undefined ? Number(output.size_bytes) : undefined,
        aspectRatio: (output.aspect_ratio as string) || undefined,
        posterAssetId: (output.poster_asset_id as string) || undefined,
        posterUrl: (output.poster_signed_url as string) || undefined,
      },
    }
  }
  return {
    ...base,
    mediaKind: 'image' as const,
    // Legacy compatibility: image outputs also expose imageUrl.
    imageUrl: output.signed_url as string,
    metadata: {
      width: output.width !== null && output.width !== undefined ? Number(output.width) : undefined,
      height: output.height !== null && output.height !== undefined ? Number(output.height) : undefined,
      format: (output.mime_type as string) || undefined,
      sizeBytes: output.size_bytes !== undefined ? Number(output.size_bytes) : undefined,
      aspectRatio: (output.aspect_ratio as string) || undefined,
    },
  }
}

export async function jobDto(row: Record<string, unknown>, outputs: Record<string, unknown>[] = [], inputs: Record<string, unknown>[] = []) {
  const inputPrompt = (row.input_prompt as string) || (row.prompt as string)
  const canReadFinalPrompt = Boolean(row.allow_user_read_final_prompt)
  const rawInputs = (inputs && inputs.length > 0) ? inputs : ((row.input_images as Record<string, unknown>[]) || (row.inputs as Record<string, unknown>[]) || [])
  const mediaKind = ((row.media_kind as string) || (row.model_kind as string) || 'image') as string
  let normalizedParameters: Record<string, unknown> | undefined
  const rawNormalized = parseJsonField(row.normalized_request)
  if (rawNormalized && typeof rawNormalized.parameters === 'object' && rawNormalized.parameters !== null) {
    normalizedParameters = rawNormalized.parameters as Record<string, unknown>
  }
  // Only the already-sanitised provider detail is user-visible; never spread the object.
  const providerError = row.provider_error && typeof row.provider_error === 'object'
    ? row.provider_error as { detail?: unknown }
    : undefined
  const providerDetail = typeof providerError?.detail === 'string' ? providerError.detail.trim() : ''
  return {
    id: row.id,
    createdBy: row.created_by,
    modelId: row.model_id,
    modelName: row.model_name,
    mediaKind,
    model: {
      id: row.model_id,
      name: row.model_name,
      mediaKind,
      providerId: (row.provider_id as string) || undefined,
      pluginId: (row.plugin_id as string) || undefined,
      pluginVersion: (row.plugin_version as string) || undefined,
    },
    phase: row.phase || null,
    progress: row.progress !== undefined && row.progress !== null ? Number(row.progress) : undefined,
    cancelRequested: Boolean(row.cancel_requested_at),
    title: row.title || null,
    prompt: inputPrompt,
    inputPrompt,
    finalPrompt: canReadFinalPrompt ? row.final_prompt || null : null,
    canReadFinalPrompt,
    templateName: row.template_name_snapshot || null,
    optimizationMode: row.optimization_mode || 'disabled',
    optimizationStatus: row.optimization_status || null,
    parameters: normalizedParameters,
    size: row.size,
    quality: row.quality || undefined,
    count: row.count !== null && row.count !== undefined ? Number(row.count) : undefined,
    status: row.status,
    errorCode: row.error_code || undefined,
    errorMessage: providerDetail ? providerDetail.slice(0, 300) : undefined,
    createdAt: new Date(row.created_at as string | number | Date).toISOString(),
    startedAt: row.started_at ? new Date(row.started_at as string | number | Date).toISOString() : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at as string | number | Date).toISOString() : undefined,
    inputs: await Promise.all(
      rawInputs.map(async (input: Record<string, unknown>, index: number) => {
        // A gallery-sourced input owns no upload row: report it by `assetId` and
        // leave `uploadId` undefined, so no reader can mistake the reference for a
        // file this job uploaded (and try to delete or re-attach it).
        const assetId = (input.assetId as string) || (input.asset_id as string) || undefined
        const source = assetId ? 'gallery' : 'upload'
        return {
          id: input.id as string,
          uploadId: assetId ? undefined : ((input.upload_id as string) || (input.id as string)),
          assetId,
          source,
          role: (input.role as string) || 'reference_image',
          position: input.position !== undefined ? Number(input.position) : index,
          imageUrl: (input.imageUrl as string) || (input.object_key ? await signedAssetUrl(input.object_key as string) : ''),
          url: (input.imageUrl as string) || (input.object_key ? await signedAssetUrl(input.object_key as string) : ''),
          mimeType: (input.mime_type as string) || (input.mimeType as string),
          width: (input.width as number) || 0,
          height: (input.height as number) || 0,
          sizeBytes: Number(input.size_bytes ?? input.sizeBytes ?? 0),
        }
      })
    ),
    // Legacy alias preserved for existing image clients.
    inputImages: await Promise.all(
      rawInputs.map(async (input: Record<string, unknown>) => ({
        id: input.id as string,
        imageUrl: (input.imageUrl as string) || (input.object_key ? await signedAssetUrl(input.object_key as string) : ''),
        mimeType: (input.mime_type as string) || (input.mimeType as string),
        width: (input.width as number) || 0,
        height: (input.height as number) || 0,
        sizeBytes: Number(input.size_bytes ?? input.sizeBytes ?? 0),
      }))
    ),
    outputs: await Promise.all(
      outputs.map(async output => {
        const signed = output.signed_url
          ? String(output.signed_url)
          : await signedAssetUrl(output.object_key as string)
        let posterSigned: string | undefined
        if (output.poster_object_key) {
          posterSigned = await signedAssetUrl(output.poster_object_key as string)
        }
        return outputDto({ ...output, signed_url: signed, poster_signed_url: posterSigned || output.poster_signed_url })
      })
    ),
  }
}

export function adminJobDto(row: Record<string, unknown>) {
  const startedAt = row.started_at ? new Date(row.started_at as string | number | Date) : undefined
  const completedAt = row.completed_at ? new Date(row.completed_at as string | number | Date) : undefined
  return {
    id: row.id,
    createdBy: row.created_by,
    modelId: row.model_id,
    modelName: row.model_name,
    mediaKind: ((row.media_kind as string) || 'image') as string,
    providerId: (row.provider_id as string) || undefined,
    pluginId: (row.plugin_id as string) || undefined,
    pluginVersion: (row.plugin_version as string) || undefined,
    phase: row.phase || null,
    progress: row.progress !== undefined && row.progress !== null ? Number(row.progress) : undefined,
    templateName: row.template_name_snapshot || null,
    languageModelName: row.language_model_name_snapshot || null,
    languageModelVendorId: row.language_model_vendor_id_snapshot || null,
    languageModelProtocol: row.language_model_protocol_snapshot || null,
    status: row.status,
    errorCode: row.error_code || undefined,
    providerError: row.provider_error && typeof row.provider_error === 'object'
      ? row.provider_error as { status?: number; providerReferenceId?: string; [key: string]: unknown }
      : undefined,
    providerReferenceId: row.provider_reference_id || undefined,
    durationMs: startedAt && completedAt ? completedAt.getTime() - startedAt.getTime() : undefined,
    createdAt: new Date(row.created_at as string | number | Date).toISOString(),
    completedAt: completedAt?.toISOString(),
  }
}

export function providerCredentialDto(row: Record<string, unknown>) {
  const configured = parseJsonField(row.configured_fields) || {}
  return {
    id: row.id as string,
    displayName: row.display_name as string,
    providerId: (row.provider_id as string) || undefined,
    schemaId: (row.schema_id as string) || 'legacy-api-key-v1',
    schemaVersion: row.schema_version !== undefined && row.schema_version !== null ? Number(row.schema_version) : 1,
    // Legacy adapter fields preserved for existing clients.
    adapter: (row.adapter as string) || (row.provider_id as string) || undefined,
    baseUrl: (row.base_url as string) || '',
    enabled: Boolean(row.enabled),
    // Secrets are write-only: only presence and fingerprint are exposed.
    hasCredential: Boolean(row.payload_encrypted || row.api_key_encrypted),
    hasApiKey: Boolean(row.payload_encrypted || row.api_key_encrypted),
    keyFingerprint: ((row.api_key_fingerprint as string) || (configured.apiKeyFingerprint as string)) || undefined,
    configuredFields: Object.fromEntries(
      Object.entries(configured).filter(([key]) => !['apiKey', 'key', 'secret', 'token'].includes(key)),
    ),
    lastTestStatus: (row.last_test_status as string) || 'not_tested',
    lastTestErrorCode: (row.last_test_error_code as string) || undefined,
    lastTestedAt: row.last_tested_at ? new Date(row.last_tested_at as string | number | Date).toISOString() : undefined,
    updatedAt: new Date(row.updated_at as string | number | Date).toISOString(),
  }
}

export function oauthIdentityDto(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    provider: row.provider as string,
    email: (row.email_at_link as string) || undefined,
    displayName: (row.display_name as string) || undefined,
    avatarUrl: (row.avatar_url as string) || undefined,
    linkedAt: new Date(row.linked_at as string | number | Date).toISOString(),
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at as string | number | Date).toISOString() : undefined,
  }
}

export { parseJsonField as parseRevisionJsonField, parseDescriptorArray as parseParameterDescriptors }
