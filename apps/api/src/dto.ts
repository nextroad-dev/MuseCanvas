import { signedAssetUrl } from './services'

export const userDto = (row: any) => ({ id: row.id, email: row.email, role: row.role, status: row.status, createdAt: new Date(row.created_at).toISOString() })
export const publicModelDto = (row: any) => ({ id: row.id, displayName: row.display_name, adapter: row.adapter, sizes: row.sizes, qualityOptions: row.quality_options, maxCount: row.max_count, enabled: row.enabled, sortOrder: row.sort_order })
export const modelDto = (row: any) => ({ ...publicModelDto(row), vendorModelId: row.vendor_model_id, baseUrl: row.base_url || '', concurrencyLimit: row.concurrency_limit, watermark: row.watermark, providerCredentialId: row.provider_credential_id || undefined, providerCredentialName: row.provider_credential_name || undefined })
export async function jobDto(row: any, outputs: any[] = []) {
  return { id: row.id, createdBy: row.created_by, modelId: row.model_id, modelName: row.model_name, prompt: row.prompt, size: row.size, quality: row.quality || undefined, count: row.count, status: row.status, errorCode: row.error_code || undefined, createdAt: new Date(row.created_at).toISOString(), startedAt: row.started_at?.toISOString(), completedAt: row.completed_at?.toISOString(), outputs: await Promise.all(outputs.map(async output => ({ id: output.asset_id, assetId: output.asset_id, imageUrl: await signedAssetUrl(output.object_key) }))) }
}

export function adminJobDto(row: any) {
  return {
    id: row.id,
    createdBy: row.created_by,
    modelId: row.model_id,
    modelName: row.model_name,
    status: row.status,
    errorCode: row.error_code || undefined,
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
