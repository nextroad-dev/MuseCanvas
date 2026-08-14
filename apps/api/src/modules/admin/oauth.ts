import { NextResponse } from 'next/server'
import { db } from '../../../../../packages/database/src/index'
import { type Actor } from '../../auth/security'
import { encryptOAuthSecret } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { oauthSetting, oauthProviderLabels } from '../auth/oauth-settings'
import { type OAuthProvider } from '../../auth/oauth'

export async function updateOAuthProvider(
  actor: Actor,
  provider: OAuthProvider,
  input: Record<string, unknown>,
): Promise<NextResponse> {
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : undefined
  const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : undefined
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : undefined
  if (clientId !== undefined && clientId.length > 300) return fail('INVALID_INPUT', 'Client ID 过长')
  if (clientSecret !== undefined && clientSecret.length > 1000)
    return fail('INVALID_INPUT', 'Client Secret 过长')
  const secretEncrypted = clientSecret ? encryptOAuthSecret(clientSecret) : undefined
  const result = await db().query(
    'INSERT INTO oauth_provider_settings(provider,client_id,client_secret_encrypted,enabled,updated_by) VALUES($1,$2,$3,COALESCE($4,false),$5) ON CONFLICT(provider) DO UPDATE SET client_id=COALESCE(EXCLUDED.client_id,oauth_provider_settings.client_id),client_secret_encrypted=COALESCE(EXCLUDED.client_secret_encrypted,oauth_provider_settings.client_secret_encrypted),enabled=COALESCE(EXCLUDED.enabled,oauth_provider_settings.enabled),updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *',
    [provider, clientId || null, secretEncrypted || null, enabled, actor.id],
  )
  await db().query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,summary) VALUES($1,$2,$3,$4,$5)', [actor.id, 'oauth_provider.update', 'oauth_provider', provider, JSON.stringify({ enabled })])
  const setting = await oauthSetting(provider)
  const row = result.rows[0]
  return ok({
    provider,
    label: oauthProviderLabels[provider],
    enabled: setting.enabled,
    configuredInDatabase: !!row.enabled,
    source: setting.source,
    clientId: row.client_id || '',
    hasClientSecret: !!row.client_secret_encrypted,
    redirectUri: `${setting.config.redirectBaseUrl.replace(/\/$/, '')}/api/auth/oauth/${provider}/callback`,
  })
}