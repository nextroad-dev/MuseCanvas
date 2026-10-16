import { db, findProviderCredential, transaction } from '@musecanvas/database'
import { decodeCredential, urlHostOf } from '@musecanvas/providers'
import { encryptProviderCredential, fingerprintApiKey } from '../../../auth/security'
import { writeAudit } from '../../../shared/audit'
import { providerCredentialDto } from '../../../shared/dto'
import { fail, ok } from '../../../shared/http'
import { parseCredentialInput, type CredentialInput } from './input'
import { resolveCredentialTarget, type CredentialTarget } from './validate'

/**
 * Credential writes. Rows are written in the current shape only: the whole payload
 * in `payload_encrypted` under the current key id, provider account and schema in
 * their columns, and in `configured_fields` nothing but display metadata (presence,
 * fingerprint) plus the template plugin hint. The legacy `api_key_encrypted`,
 * `api_key_fingerprint` and `adapter` columns are no longer written; every reader
 * already prefers the payload.
 */

type Sealed = { ciphertext: string; keyId: string; configured: Record<string, unknown> }

function seal(secret: string, target: CredentialTarget): Sealed | null {
  let envelope: { ciphertext: string; keyId: string }
  try {
    envelope = encryptProviderCredential(secret)
  } catch {
    return null
  }
  // The fingerprint identifies the key an admin pasted, so it is taken over the API
  // key when the payload has one and over the whole payload otherwise. Always the
  // keyed HMAC: an unkeyed hash of a low-entropy secret would be brute-forceable.
  let apiKey: string | undefined
  try {
    apiKey = decodeCredential(secret, target.schemaId).apiKey
  } catch {
    apiKey = undefined
  }
  return {
    ciphertext: envelope.ciphertext,
    keyId: envelope.keyId,
    configured: {
      hasApiKey: Boolean(apiKey),
      apiKeyFingerprint: fingerprintApiKey(apiKey ?? secret),
      ...(target.plugin ? { pluginId: target.plugin.pluginId, pluginVersion: target.plugin.pluginVersion } : {}),
    },
  }
}

const ENCRYPT_FAILED = () => fail('CREDENTIAL_ENCRYPT_FAILED', '凭据加密失败，请检查加密配置', 500)

export async function createProviderCredential(actor: { id: string }, body: Record<string, unknown>) {
  const parsed = parseCredentialInput(body)
  if (!parsed.ok) return fail(parsed.code, parsed.message)
  const input = parsed.input
  const displayName = input.displayName
  if (!displayName) return fail('INVALID_INPUT', '凭据名称不能为空')
  if (!input.secret) return fail('INVALID_INPUT', '凭据内容不能为空（secret）')
  const resolved = await resolveCredentialTarget(input)
  if (!resolved.ok) return fail(resolved.code, resolved.message)
  const target = resolved.value
  const sealed = seal(input.secret, target)
  if (!sealed) return ENCRYPT_FAILED()
  const created = await transaction(async (client) => {
    const r = await client.query(
      `INSERT INTO provider_credentials(display_name,provider_id,schema_id,schema_version,base_url,payload_encrypted,encryption_key_id,
        configured_fields,enabled,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
      [displayName, target.providerId, target.schemaId, target.schemaVersion, target.baseUrl, sealed.ciphertext, sealed.keyId,
        JSON.stringify(sealed.configured), input.enabled === true, actor.id],
    )
    await writeAudit(client, actor.id, 'provider_credential.create', 'provider_credential', r.rows[0].id, {
      displayName: r.rows[0].display_name,
      providerId: r.rows[0].provider_id,
      baseUrl: r.rows[0].base_url,
    })
    return r.rows[0]
  })
  return ok(providerCredentialDto(created))
}

function hostOf(value: string | null | undefined): string | null {
  return value ? (urlHostOf(value)?.toLowerCase() ?? value) : null
}

function storedPluginHint(configured: Record<string, unknown> | null): CredentialInput['plugin'] {
  const pluginId = typeof configured?.pluginId === 'string' && configured.pluginId.trim() ? configured.pluginId.trim() : undefined
  const pluginVersion = typeof configured?.pluginVersion === 'string' && configured.pluginVersion.trim() ? configured.pluginVersion.trim() : undefined
  return pluginId && pluginVersion ? { pluginId, pluginVersion } : undefined
}

/**
 * Whether an update points the stored secret somewhere else: another provider
 * account, schema, template plugin or endpoint host. A masked secret must never be
 * silently redirected, so any of these requires the secret again in the same request.
 */
export function credentialRedirected(
  current: { providerId: string | null; schemaId: string | null; baseUrl: string | null; plugin?: CredentialInput['plugin'] },
  next: { providerId: string | null; schemaId: string | null; baseUrl: string | null; plugin?: CredentialInput['plugin'] },
): boolean {
  const pluginKey = (plugin: CredentialInput['plugin']) => (plugin ? `${plugin.pluginId}@${plugin.pluginVersion}` : null)
  return (
    next.providerId !== current.providerId ||
    next.schemaId !== current.schemaId ||
    pluginKey(next.plugin) !== pluginKey(current.plugin) ||
    hostOf(next.baseUrl) !== hostOf(current.baseUrl)
  )
}

export async function updateProviderCredential(actor: { id: string }, id: string, body: Record<string, unknown>) {
  const row = await findProviderCredential(db(), id)
  if (!row) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  const parsed = parseCredentialInput(body)
  if (!parsed.ok) return fail(parsed.code, parsed.message)
  const input = parsed.input
  const configured = (row.configured_fields ?? {}) as Record<string, unknown>
  const current = {
    providerId: row.provider_id,
    schemaId: row.schema_id,
    baseUrl: row.base_url,
    plugin: storedPluginHint(configured),
  }
  const next = {
    providerId: input.providerId ?? current.providerId,
    schemaId: input.schemaId ?? current.schemaId,
    baseUrl: input.baseUrl !== undefined ? input.baseUrl : current.baseUrl,
    plugin: input.plugin ?? current.plugin,
  }
  const redirected = credentialRedirected(current, next)
  if (redirected && input.secret === undefined) {
    return fail('SECRET_REQUIRED_FOR_REDIRECT', '更改凭据目标（供应商/插件/主机）时必须提供新密钥', 422)
  }

  // Metadata-only updates (name, enabled, schema version) touch neither the secret
  // nor its target, so there is nothing to re-validate.
  let target: CredentialTarget | null = null
  let sealed: Sealed | null = null
  if (input.secret !== undefined) {
    const resolved = await resolveCredentialTarget({
      providerId: next.providerId ?? undefined,
      plugin: next.plugin,
      schemaId: next.schemaId ?? undefined,
      schemaVersion: input.schemaVersion ?? row.schema_version,
      baseUrl: next.baseUrl,
      secret: input.secret,
    })
    if (!resolved.ok) return fail(resolved.code, resolved.message)
    target = resolved.value
    sealed = seal(input.secret, target)
    if (!sealed) return ENCRYPT_FAILED()
  }

  const updated = await transaction(async (client) => {
    const r = await client.query(
      `UPDATE provider_credentials SET
         display_name=COALESCE($2,display_name),
         enabled=COALESCE($3,enabled),
         schema_version=COALESCE($4,schema_version),
         provider_id=CASE WHEN $5::boolean THEN $6 ELSE provider_id END,
         schema_id=CASE WHEN $5::boolean THEN $7 ELSE schema_id END,
         base_url=CASE WHEN $5::boolean THEN $8 ELSE base_url END,
         payload_encrypted=CASE WHEN $5::boolean THEN $9 ELSE payload_encrypted END,
         encryption_key_id=CASE WHEN $5::boolean THEN $10 ELSE encryption_key_id END,
         configured_fields=CASE WHEN $5::boolean THEN $11::jsonb ELSE configured_fields END,
         updated_at=now(),updated_by=$12
       WHERE id=$1 AND deleted_at IS NULL RETURNING *`,
      [
        id,
        input.displayName ?? null,
        input.enabled ?? null,
        target ? target.schemaVersion : (input.schemaVersion ?? null),
        Boolean(target),
        target?.providerId ?? null,
        target?.schemaId ?? null,
        target?.baseUrl ?? null,
        sealed?.ciphertext ?? null,
        sealed?.keyId ?? null,
        sealed ? JSON.stringify(sealed.configured) : null,
        actor.id,
      ],
    )
    if (!r.rows[0]) return null
    await writeAudit(client, actor.id, 'provider_credential.update', 'provider_credential', id, {
      secretRotated: Boolean(target),
      targetChanged: redirected,
    })
    return r.rows[0]
  })
  if (!updated) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  return ok(providerCredentialDto(updated))
}

export async function deleteProviderCredential(actor: { id: string }, id: string) {
  const inUse = await db().query(
    'SELECT id FROM model_configs WHERE provider_credential_id=$1 AND deleted_at IS NULL LIMIT 1',
    [id],
  )
  if (inUse.rows[0]) return fail('CREDENTIAL_IN_USE', '该凭据仍被模型使用，无法删除', 409)
  const deleted = await transaction(async (client) => {
    const r = await client.query(
      'UPDATE provider_credentials SET deleted_at=now(),enabled=false,updated_at=now(),updated_by=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id, display_name',
      [id, actor.id],
    )
    if (!r.rows[0]) return null
    await writeAudit(client, actor.id, 'provider_credential.delete', 'provider_credential', id, {
      displayName: r.rows[0].display_name,
    })
    return r.rows[0]
  })
  if (!deleted) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  return ok({ deleted: true })
}
