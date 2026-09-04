import type { DecodedCredential } from './types'
import { NormalizedProviderError } from './errors'

/**
 * Decodes credentials after caller decrypts them.
 * Supports:
 * - 'legacy-api-key-v1': raw string API key or object with apiKey property
 * - 'json-v1' or arbitrary JSON string / object with apiKey, baseUrl, etc.
 *
 * Never reads process.env or logs secrets.
 */
export function decodeCredential(
  raw: unknown,
  schemaHint?: string,
  pluginId = 'core',
  version = '1.0.0',
): DecodedCredential {
  if (!raw) {
    throw NormalizedProviderError.create(
      pluginId,
      version,
      'INVALID_CREDENTIAL',
      'Credential payload is empty or missing',
    )
  }

  // If raw is a string, check if it's JSON or a legacy raw API key string
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed)
        return decodeFromObject(parsed, schemaHint)
      } catch {
        // Fall back to legacy string
      }
    }

    return {
      schema: schemaHint || 'legacy-api-key-v1',
      apiKey: trimmed,
    }
  }

  if (typeof raw === 'object' && raw !== null) {
    return decodeFromObject(raw as Record<string, unknown>, schemaHint)
  }

  throw NormalizedProviderError.create(
    pluginId,
    version,
    'INVALID_CREDENTIAL',
    'Unsupported credential format',
  )
}

function decodeFromObject(
  obj: Record<string, unknown>,
  schemaHint?: string,
): DecodedCredential {
  const schema = (obj.schema as string) || schemaHint || 'json-v1'
  const apiKey = typeof obj.apiKey === 'string' ? obj.apiKey : typeof obj.key === 'string' ? obj.key : undefined
  const baseUrl = typeof obj.baseUrl === 'string' ? obj.baseUrl : undefined

  const { schema: _, apiKey: _k, key: _k2, baseUrl: _b, ...extra } = obj

  return {
    schema,
    apiKey,
    baseUrl,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  }
}
