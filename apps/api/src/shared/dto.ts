import { signedAssetUrl } from './services'

export const userDto = (row: any) => ({ id: row.id, email: row.email, role: row.role, status: row.status, createdAt: new Date(row.created_at).toISOString() })
export const publicModelDto = (row: any) => ({ id: row.id, displayName: row.display_name, adapter: row.adapter, sizes: row.sizes || [], qualityOptions: row.quality_options || [], maxCount: row.max_count || 0, enabled: row.enabled, sortOrder: row.sort_order })
export const modelDto = (row: any) => ({ ...publicModelDto(row), presetId: row.preset_id || undefined, modelKind: row.model_kind || 'image', languageProtocol: row.language_protocol || undefined, maxOutputTokens: row.max_output_tokens || undefined, temperature: row.temperature === null || row.temperature === undefined ? undefined : Number(row.temperature), reasoningEffort: row.reasoning_effort || undefined, vendorModelId: row.vendor_model_id, baseUrl: row.base_url || '', concurrencyLimit: row.concurrency_limit, watermark: row.watermark, providerCredentialId: row.provider_credential_id || undefined, providerCredentialName: row.provider_credential_name || undefined })
export async function jobDto(row: any, outputs: any[] = []) {
  const inputPrompt = row.input_prompt || row.prompt
  const canReadFinalPrompt = !!row.allow_user_read_final_prompt
  return { id: row.id, createdBy: row.created_by, modelId: row.model_id, modelName: row.model_name, title: row.title || null, prompt: inputPrompt, inputPrompt, finalPrompt: canReadFinalPrompt ? row.final_prompt || null : null, canReadFinalPrompt, templateName: row.template_name_snapshot || null, phase: row.phase || null, optimizationMode: row.optimization_mode || 'disabled', optimizationStatus: row.optimization_status || null, size: row.size, quality: row.quality || undefined, count: row.count, status: row.status, errorCode: row.error_code || undefined, createdAt: new Date(row.created_at).toISOString(), startedAt: row.started_at?.toISOString(), completedAt: row.completed_at?.toISOString(), outputs: await Promise.all(outputs.map(async output => ({ id: output.asset_id, assetId: output.asset_id, imageUrl: await signedAssetUrl(output.object_key) }))) }
}

export function adminJobDto(row: any) {
  return {
    id: row.id,
    createdBy: row.created_by,
    modelId: row.model_id,
    modelName: row.model_name,
    phase: row.phase || null,
    templateName: row.template_name_snapshot || null,
    languageModelName: row.language_model_name_snapshot || null,
    languageModelVendorId: row.language_model_vendor_id_snapshot || null,
    languageModelProtocol: row.language_model_protocol_snapshot || null,
    status: row.status,
    errorCode: row.error_code || undefined,
    providerError: row.provider_error || undefined,
    providerReferenceId: row.provider_reference_id || undefined,
    durationMs: row.started_at && row.completed_at ? row.completed_at.getTime() - row.started_at.getTime() : undefined,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
  }
}

export function providerCredentialDto(row: any) {
  return {
    id: row.id,
    displayName: row.display_name,
    adapter: row.adapter,
    baseUrl: row.base_url || '',
    enabled: row.enabled,
    hasApiKey: !!row.api_key_encrypted,
    keyFingerprint: row.api_key_fingerprint || undefined,
    lastTestStatus: row.last_test_status || 'not_tested',
    lastTestErrorCode: row.last_test_error_code || undefined,
    lastTestedAt: row.last_tested_at?.toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export function oauthIdentityDto(row: any) {
  return {
    provider: row.provider,
    providerSubject: row.provider_subject,
    emailAtLink: row.email_at_link,
    displayName: row.display_name || undefined,
    avatarUrl: row.avatar_url || undefined,
    linkedAt: new Date(row.linked_at).toISOString(),
    lastLoginAt: new Date(row.last_login_at).toISOString(),
  }
}
