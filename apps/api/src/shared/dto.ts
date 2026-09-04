import { signedAssetUrl } from './services'

export const userDto = (row: Record<string, unknown>, creditBalance?: Record<string, unknown> | null) => ({
  id: row.id as string,
  email: row.email as string,
  role: row.role as string,
  status: row.status as string,
  createdAt: new Date(row.created_at as string | number | Date).toISOString(),
  ...(creditBalance !== undefined
    ? {
      creditBalance: creditBalance
        ? {
          availableCredits: Number((creditBalance as Record<string, unknown>).available_credits || 0),
          reservedCredits: Number((creditBalance as Record<string, unknown>).reserved_credits || 0),
          updatedAt: (creditBalance as Record<string, unknown>).updated_at
            ? new Date((creditBalance as Record<string, unknown>).updated_at as string | number | Date).toISOString()
            : undefined,
        }
        : null,
    }
    : {}),
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

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return []
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

export function capabilitiesFromRow(row: Record<string, unknown>): {
  modes: string[]
  parameters: Record<string, unknown>[]
  inputSlots: Record<string, unknown>[]
  maxCount: number
  supportedMediaKinds: string[]
} {
  const snapshot = parseJsonField(row.capabilities)
  const mediaKind = (row.media_kind as string) || (row.model_kind as string) || 'image'
  if (snapshot && (Array.isArray(snapshot.modes) || Array.isArray(snapshot.parameters) || Array.isArray(snapshot.inputSlots))) {
    return {
      modes: Array.isArray(snapshot.modes) ? (snapshot.modes as unknown[]).map(String) : [],
      parameters: Array.isArray(snapshot.parameters) ? (snapshot.parameters as Record<string, unknown>[]) : [],
      inputSlots: Array.isArray(snapshot.inputSlots) ? (snapshot.inputSlots as Record<string, unknown>[]) : [],
      maxCount: typeof snapshot.maxCount === 'number' ? snapshot.maxCount : Number(row.max_count || 1),
      supportedMediaKinds: Array.isArray(snapshot.supportedMediaKinds)
        ? (snapshot.supportedMediaKinds as unknown[]).map(String)
        : [mediaKind],
    }
  }
  // Legacy image-shaped capability snapshot (backfill format) or raw columns.
  const sizes = (row.sizes as string[] | string | null | undefined) !== undefined && row.sizes !== null
    ? parseJsonArray(row.sizes)
    : []
  const qualityOptions = row.quality_options !== undefined && row.quality_options !== null
    ? parseJsonArray(row.quality_options)
    : []
  const maxCount = Number(row.max_count || snapshot?.maxCount || 1)
  const maxInputImages = row.max_input_images !== undefined && row.max_input_images !== null
    ? Number(row.max_input_images)
    : Number((snapshot as Record<string, unknown> | null)?.maxInputImages || 0)
  const parameters: Record<string, unknown>[] = []
  if (sizes.length > 0 || mediaKind === 'image') {
    parameters.push({ type: 'enum', name: 'size', label: '尺寸', options: sizes })
  }
  if (qualityOptions.length > 0) {
    parameters.push({ type: 'enum', name: 'quality', label: '质量', options: qualityOptions })
  }
  parameters.push({ type: 'integer', name: 'count', label: '数量', min: 1, max: maxCount || 10, defaultValue: 1 })
  const inputSlots: Record<string, unknown>[] = maxInputImages > 0
    ? [{ role: 'reference_image', required: false, minCount: 0, maxCount: maxInputImages, allowedMediaKinds: ['image'] }]
    : []
  return {
    modes: mediaKind === 'video'
      ? ['text_to_video', 'image_to_video']
      : mediaKind === 'image'
        ? ['text_to_image', 'image_to_image']
        : [],
    parameters,
    inputSlots,
    maxCount: maxCount || 1,
    supportedMediaKinds: [mediaKind],
  }
}

export function pricingFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const snapshot = parseJsonField(row.pricing)
  if (snapshot && typeof snapshot.scheme === 'string') return snapshot
  return { scheme: 'per_image_v1', creditsPerImage: Number(row.credits_per_image || 0) }
}

export function defaultsFromRow(row: Record<string, unknown>): Record<string, unknown> {
  return parseJsonField(row.defaults) || {}
}

export const publicModelDto = (row: Record<string, unknown>) => {
  const modelKind = (row.media_kind as string) || (row.model_kind as string) || 'image'
  const capabilities = capabilitiesFromRow(row)
  const pricing = pricingFromRow(row)
  const defaults = defaultsFromRow(row)
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
    pricing,
    defaults,
    // Legacy image fields for compatibility.
    adapter: row.adapter as string,
    sizes: Array.isArray(row.sizes) ? (row.sizes as string[]).map(String) : parseJsonArray(row.sizes),
    qualityOptions: Array.isArray(row.quality_options) ? (row.quality_options as string[]).map(String) : parseJsonArray(row.quality_options),
    maxCount: Number(row.max_count || capabilities.maxCount || 0),
    maxInputImages: row.max_input_images !== undefined && row.max_input_images !== null ? Number(row.max_input_images) : 0,
    enabled: Boolean(row.enabled),
    sortOrder: Number(row.sort_order || 0),
    creditsPerImage: Number(row.credits_per_image || 0),
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
    quotedCredits: row.quoted_credits !== undefined && row.quoted_credits !== null ? Number(row.quoted_credits) : undefined,
    billingState: (row.billing_state as string) || undefined,
    createdAt: new Date(row.created_at as string | number | Date).toISOString(),
    startedAt: row.started_at ? new Date(row.started_at as string | number | Date).toISOString() : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at as string | number | Date).toISOString() : undefined,
    inputs: await Promise.all(
      rawInputs.map(async (input: Record<string, unknown>, index: number) => ({
        id: input.id as string,
        uploadId: (input.id as string) || (input.upload_id as string),
        role: (input.role as string) || 'reference_image',
        position: input.position !== undefined ? Number(input.position) : index,
        imageUrl: (input.imageUrl as string) || (input.object_key ? await signedAssetUrl(input.object_key as string) : ''),
        url: (input.imageUrl as string) || (input.object_key ? await signedAssetUrl(input.object_key as string) : ''),
        mimeType: (input.mime_type as string) || (input.mimeType as string),
        width: (input.width as number) || 0,
        height: (input.height as number) || 0,
        sizeBytes: Number(input.size_bytes ?? input.sizeBytes ?? 0),
      }))
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
    quotedCredits: row.quoted_credits !== undefined && row.quoted_credits !== null ? Number(row.quoted_credits) : undefined,
    billingState: (row.billing_state as string) || undefined,
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

export function creditLedgerDto(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    operation: row.operation as string,
    availableDelta: Number(row.available_delta || 0),
    reservedDelta: Number(row.reserved_delta || 0),
    availableAfter: Number(row.available_after || 0),
    reservedAfter: Number(row.reserved_after || 0),
    referenceType: (row.reference_type as string) || undefined,
    referenceId: (row.reference_id as string) || undefined,
    note: (row.note as string) || undefined,
    createdAt: new Date(row.created_at as string | number | Date).toISOString(),
  }
}

export function billingSettingsDto(row: Record<string, unknown>, promptOptRow?: Record<string, unknown>) {
  return {
    enabled: Boolean(row.enabled),
    signupGrant: Number(row.signup_grant || 0),
    promptOptimizationCredits: promptOptRow ? Number(promptOptRow.credits_per_job || 0) : undefined,
    updatedAt: new Date(row.updated_at as string | number | Date).toISOString(),
  }
}

export { parseJsonField as parseRevisionJsonField, parseDescriptorArray as parseParameterDescriptors }
