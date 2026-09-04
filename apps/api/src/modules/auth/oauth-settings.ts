import { decryptOAuthSecret } from '../../auth/security'
import { db } from '../../../../../packages/database/src/index'
import { envOAuthConfig, runtimeProviderConfigured, type OAuthProvider, type OAuthRuntimeConfig } from '../../auth/oauth'
import { resolvePublicOrigin } from '../settings/runtime'

export type OAuthSettingRow = {
  provider: OAuthProvider
  client_id?: string | null
  client_secret_encrypted?: string | null
  encryption_key_id?: string | null
  enabled?: boolean
}

export const oauthProviderLabels: Record<OAuthProvider, string> = { github: 'GitHub', google: 'Google' }

function decryptOptionalSecret(value?: string | null, keyId?: string | null): string {
  if (!value) return ''
  try {
    return decryptOAuthSecret(value, keyId ?? null)
  } catch {
    return ''
  }
}

export async function oauthSetting(
  provider: OAuthProvider,
): Promise<{
  row?: OAuthSettingRow
  config: OAuthRuntimeConfig
  enabled: boolean
  source: 'database' | 'environment' | 'none'
}> {
  const result = await db().query(
    'SELECT provider,client_id,client_secret_encrypted,encryption_key_id,enabled FROM oauth_provider_settings WHERE provider=$1',
    [provider],
  )
  const row = result.rows[0] as OAuthSettingRow | undefined
  const env = envOAuthConfig(provider)
  // Persisted site origin; the resolver falls back to legacy env during compatibility.
  const origin = await resolvePublicOrigin()
  const dbClientId = row?.client_id || ''
  const dbClientSecret = decryptOptionalSecret(row?.client_secret_encrypted, row?.encryption_key_id)
  const dbComplete = Boolean(dbClientId && dbClientSecret)
  // A seeded-but-untouched row (disabled, no values) is not DB configuration:
  // legacy env-only installations keep working through the environment path.
  const dbOwned = Boolean(row && (row.enabled || row.client_id || row.client_secret_encrypted))
  if (!dbOwned) {
    const envConfig: OAuthRuntimeConfig = { ...env, redirectBaseUrl: origin || env.redirectBaseUrl }
    if (runtimeProviderConfigured(envConfig))
      return { row, config: envConfig, enabled: true, source: 'environment' }
    return { row, config: envConfig, enabled: false, source: 'none' }
  }
  // DB-owned rows no longer take active client-id/secret precedence from env;
  // env only seeds fields an incomplete row lacks (one compatibility release).
  const config: OAuthRuntimeConfig = dbComplete
    ? { clientId: dbClientId, clientSecret: dbClientSecret, redirectBaseUrl: origin }
    : {
        clientId: dbClientId || env.clientId,
        clientSecret: dbClientSecret || env.clientSecret,
        redirectBaseUrl: origin,
      }
  if (row?.enabled && runtimeProviderConfigured(config))
    return { row, config, enabled: true, source: dbComplete ? 'database' : 'environment' }
  return { row, config, enabled: false, source: 'none' }
}

export async function oauthProviderList() {
  const providers: OAuthProvider[] = ['github', 'google']
  return Promise.all(
    providers.map(async (provider) => {
      const setting = await oauthSetting(provider)
      return { provider, label: oauthProviderLabels[provider], enabled: setting.enabled }
    }),
  )
}

export async function adminOAuthSettings() {
  const providers: OAuthProvider[] = ['github', 'google']
  return Promise.all(
    providers.map(async (provider) => {
      const setting = await oauthSetting(provider)
      const row = setting.row
      return {
        provider,
        label: oauthProviderLabels[provider],
        enabled: setting.enabled,
        configuredInDatabase: !!row?.enabled,
        source: setting.source,
        clientId: row?.client_id || '',
        hasClientSecret: !!row?.client_secret_encrypted,
        redirectUri: `${setting.config.redirectBaseUrl.replace(/\/$/, '')}/api/auth/oauth/${provider}/callback`,
      }
    }),
  )
}
