import { decryptOAuthSecret } from '../../auth/security'
import { db } from '../../../../../packages/database/src/index'
import { envOAuthConfig, runtimeProviderConfigured, type OAuthProvider, type OAuthRuntimeConfig } from '../../auth/oauth'

export type OAuthSettingRow = {
  provider: OAuthProvider
  client_id?: string | null
  client_secret_encrypted?: string | null
  enabled?: boolean
}

export const oauthProviderLabels: Record<OAuthProvider, string> = { github: 'GitHub', google: 'Google' }

function decryptOptionalSecret(value?: string | null): string {
  if (!value) return ''
  try {
    return decryptOAuthSecret(value)
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
    'SELECT provider,client_id,client_secret_encrypted,enabled FROM oauth_provider_settings WHERE provider=$1',
    [provider],
  )
  const row = result.rows[0] as OAuthSettingRow | undefined
  const env = envOAuthConfig(provider)
  const dbConfig = row
    ? {
        clientId: row.client_id || '',
        clientSecret: decryptOptionalSecret(row.client_secret_encrypted),
        redirectBaseUrl: env.redirectBaseUrl,
      }
    : env
  if (row?.enabled && runtimeProviderConfigured(dbConfig))
    return { row, config: dbConfig, enabled: true, source: 'database' }
  if (runtimeProviderConfigured(env))
    return { row, config: env, enabled: true, source: 'environment' }
  return { row, config: dbConfig, enabled: false, source: 'none' }
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