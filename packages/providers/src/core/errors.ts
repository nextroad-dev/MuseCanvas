import type { NormalizedProviderErrorDiagnostic } from './types'

export function sanitizeProviderDetail(value: string): string {
  if (!value) return ''
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .slice(0, 1200)
}

export function extractProviderReferenceId(headers: Headers): string | undefined {
  return (
    headers.get('x-request-id') ||
    headers.get('request-id') ||
    headers.get('openai-organization') ||
    headers.get('x-volc-trace-id') ||
    headers.get('x-tt-logid') ||
    undefined
  )
}

export class NormalizedProviderError extends Error {
  readonly diagnostic: NormalizedProviderErrorDiagnostic

  constructor(code: NormalizedProviderErrorDiagnostic['code'], diagnostic: NormalizedProviderErrorDiagnostic) {
    super(code)
    this.name = 'NormalizedProviderError'
    this.diagnostic = diagnostic
  }

  static fromHttp(
    pluginId: string,
    version: string,
    response: { status: number; statusText: string; headers: Headers; url: string },
    bodyText: string,
  ): NormalizedProviderError {
    let endpoint = ''
    try {
      endpoint = new URL(response.url).pathname
    } catch {
      endpoint = response.url
    }

    const detail = sanitizeProviderDetail(bodyText)
    const code =
      response.status === 429 || response.status >= 500
        ? 'PROVIDER_TEMPORARY_ERROR'
        : 'PROVIDER_REJECTED'

    const diagnostic: NormalizedProviderErrorDiagnostic = {
      pluginId,
      version,
      code,
      status: response.status,
      statusText: response.statusText,
      endpoint,
      detail,
      occurredAt: new Date().toISOString(),
      providerReferenceId: extractProviderReferenceId(response.headers),
    }

    return new NormalizedProviderError(code, diagnostic)
  }

  static create(
    pluginId: string,
    version: string,
    code: NormalizedProviderErrorDiagnostic['code'],
    detail: string,
    extra?: Partial<NormalizedProviderErrorDiagnostic>,
  ): NormalizedProviderError {
    const diagnostic: NormalizedProviderErrorDiagnostic = {
      pluginId,
      version,
      code,
      detail: sanitizeProviderDetail(detail),
      occurredAt: new Date().toISOString(),
      ...extra,
    }
    return new NormalizedProviderError(code, diagnostic)
  }
}

export class SafeHttpError extends NormalizedProviderError {
  constructor(diagnostic: NormalizedProviderErrorDiagnostic) {
    super(diagnostic.code, diagnostic)
    this.name = 'SafeHttpError'
    this.message = `${diagnostic.code}: ${diagnostic.detail}`
  }
}
