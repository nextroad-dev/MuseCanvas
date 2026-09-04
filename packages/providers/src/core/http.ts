import type { SafeHttpClient, SafeHttpRequestInit, SafeHttpResponse } from './types'
import { NormalizedProviderError, SafeHttpError } from './errors'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_BYTES = 50_000_000 // 50 MB
const MAX_REDIRECTS = 5

export type SafeHttpClientOptions = {
  pluginId: string
  version: string
  allowedHosts: string[]
  fetchImpl?: typeof globalThis.fetch
}

export class DefaultSafeHttpClient implements SafeHttpClient {
  private readonly pluginId: string
  private readonly version: string
  private readonly allowedHosts: string[]
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: SafeHttpClientOptions) {
    this.pluginId = options.pluginId
    this.version = options.version
    this.allowedHosts = options.allowedHosts
    this.fetchImpl = options.fetchImpl || globalThis.fetch
  }

  private validateUrl(rawUrl: string, explicitAllowedHosts?: string[]): URL {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw new SafeHttpError(
        NormalizedProviderError.create(
          this.pluginId,
          this.version,
          'UNSAFE_URL',
          `Invalid URL: ${rawUrl}`,
        ).diagnostic,
      )
    }
    if (parsed.protocol !== 'https:') {
      throw new SafeHttpError(
        NormalizedProviderError.create(
          this.pluginId,
          this.version,
          'UNSAFE_URL',
          `Insecure protocol '${parsed.protocol}'; only HTTPS is permitted`,
        ).diagnostic,
      )
    }

    const hostname = parsed.hostname.toLowerCase()
    const allowed = explicitAllowedHosts || this.allowedHosts

    const isAllowed = allowed.some(pattern => {
      const p = pattern.toLowerCase().trim()
      if (p.startsWith('*.')) {
        const suffix = p.slice(1) // e.g. .volces.com
        return hostname.endsWith(suffix) && hostname.length > suffix.length
      }
      if (p.startsWith('*-')) {
        const suffix = p.slice(1) // e.g. -aiplatform.googleapis.com
        return hostname.endsWith(suffix) && hostname.length > suffix.length
      }
      return hostname === p
    })

    if (!isAllowed) {
      throw new SafeHttpError(
        NormalizedProviderError.create(
          this.pluginId,
          this.version,
          'UNSAFE_URL',
          `Host '${hostname}' is not in allowed hosts list: [${allowed.join(', ')}]`,
        ).diagnostic,
      )
    }

    return parsed
  }

  async request(url: string, init: SafeHttpRequestInit = {}): Promise<SafeHttpResponse> {
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES
    const method = init.method ?? 'GET'

    let currentUrl = url
    let redirectsFollowed = 0

    while (true) {
      const validatedUrl = this.validateUrl(currentUrl, init.allowedHosts)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const cleanup = () => clearTimeout(timer)

      let res: Response
      try {
        res = await this.fetchImpl(validatedUrl.toString(), {
          method,
          headers: init.headers,
          body: init.body as BodyInit | null | undefined,
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch (err: unknown) {
        cleanup()
        const isAbort =
          (err instanceof Error && err.name === 'AbortError') ||
          controller.signal.aborted
        if (isAbort) {
          throw NormalizedProviderError.create(
            this.pluginId,
            this.version,
            'PROVIDER_TIMEOUT',
            `Request timed out after ${timeoutMs}ms`,
          )
        }
        const message = err instanceof Error ? err.message : 'Network transport failure'
        throw NormalizedProviderError.create(
          this.pluginId,
          this.version,
          'PROVIDER_TEMPORARY_ERROR',
          message,
        )
      }

      // Handle redirects manually so every hop is independently allowlisted.
      if (res.status >= 301 && res.status <= 308) {
        cleanup()
        const location = res.headers.get('location')
        if (!location) {
          throw new SafeHttpError(
            NormalizedProviderError.create(
              this.pluginId,
              this.version,
              'UNSAFE_URL',
              `Redirect with missing Location header from ${currentUrl}`,
            ).diagnostic,
          )
        }
        let nextUrl: URL
        try {
          nextUrl = new URL(location, validatedUrl)
        } catch {
          throw new SafeHttpError(
            NormalizedProviderError.create(
              this.pluginId,
              this.version,
              'UNSAFE_URL',
              `Redirect Location is not a valid URL: ${location}`,
            ).diagnostic,
          )
        }
        currentUrl = nextUrl.toString()
        redirectsFollowed++
        if (redirectsFollowed > MAX_REDIRECTS) {
          throw new SafeHttpError(
            NormalizedProviderError.create(
              this.pluginId,
              this.version,
              'UNSAFE_URL',
              `Exceeded maximum redirect limit (${MAX_REDIRECTS})`,
            ).diagnostic,
          )
        }
        continue
      }

      return this.wrapResponse(res, currentUrl, maxBytes, cleanup)
    }
  }

  get(url: string, init?: Omit<SafeHttpRequestInit, 'method'>): Promise<SafeHttpResponse> {
    return this.request(url, { ...init, method: 'GET' })
  }

  post(
    url: string,
    body?: string | FormData | Buffer | Uint8Array,
    init?: Omit<SafeHttpRequestInit, 'method' | 'body'>,
  ): Promise<SafeHttpResponse> {
    return this.request(url, { ...init, method: 'POST', body })
  }

  private wrapResponse(
    rawResponse: Response,
    url: string,
    maxBytes: number,
    cleanup: () => void,
  ): SafeHttpResponse {
    const pluginId = this.pluginId
    const version = this.version

    let readStarted = false
    let cachedBuffer: Buffer | null = null

    const readBoundedBuffer = async (): Promise<Buffer> => {
      if (cachedBuffer) return cachedBuffer
      if (readStarted) {
        throw new Error('Response stream has already been read')
      }
      readStarted = true

      const contentLengthHeader = rawResponse.headers.get('content-length')
      if (contentLengthHeader) {
        const parsed = parseInt(contentLengthHeader, 10)
        if (!Number.isNaN(parsed) && parsed > maxBytes) {
          cleanup()
          throw new SafeHttpError(
            NormalizedProviderError.create(
              pluginId,
              version,
              'OUTPUT_READ_FAILED',
              `Content-Length ${parsed} exceeds limit of ${maxBytes} bytes`,
            ).diagnostic,
          )
        }
      }

      if (!rawResponse.body) {
        cleanup()
        cachedBuffer = Buffer.alloc(0)
        return cachedBuffer
      }

      const reader = rawResponse.body.getReader()
      const chunks: Uint8Array[] = []
      let totalBytes = 0

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            totalBytes += value.byteLength
            if (totalBytes > maxBytes) {
              await reader.cancel()
              throw new SafeHttpError(
                NormalizedProviderError.create(
                  pluginId,
                  version,
                  'OUTPUT_READ_FAILED',
                  `Response body exceeded maximum allowed size of ${maxBytes} bytes`,
                ).diagnostic,
              )
            }
            chunks.push(value)
          }
        }
      } finally {
        cleanup()
        reader.releaseLock()
      }

      cachedBuffer = Buffer.concat(chunks, totalBytes)
      return cachedBuffer
    }

    return {
      status: rawResponse.status,
      statusText: rawResponse.statusText,
      headers: rawResponse.headers,
      ok: rawResponse.ok,
      url,
      text: async () => {
        const buf = await readBoundedBuffer()
        return buf.toString('utf8')
      },
      json: async <T = unknown>() => {
        const buf = await readBoundedBuffer()
        return JSON.parse(buf.toString('utf8')) as T
      },
      buffer: () => readBoundedBuffer(),
      stream: () => {
        if (readStarted) {
          throw new Error('Response stream has already been read')
        }
        readStarted = true
        const contentLengthHeader = rawResponse.headers.get('content-length')
        if (contentLengthHeader) {
          const parsed = parseInt(contentLengthHeader, 10)
          if (!Number.isNaN(parsed) && parsed > maxBytes) {
            cleanup()
            throw new SafeHttpError(
              NormalizedProviderError.create(
                pluginId,
                version,
                'OUTPUT_READ_FAILED',
                `Content-Length ${parsed} exceeds limit of ${maxBytes} bytes`,
              ).diagnostic,
            )
          }
        }
        if (!rawResponse.body) {
          cleanup()
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          })
        }
        let totalBytes = 0
        const streamReader = rawResponse.body.getReader()
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await streamReader.read()
            if (done) {
              cleanup()
              controller.close()
              return
            }
            if (value) {
              totalBytes += value.byteLength
              if (totalBytes > maxBytes) {
                controller.error(
                  new SafeHttpError(
                    NormalizedProviderError.create(
                      pluginId,
                      version,
                      'OUTPUT_READ_FAILED',
                      `Stream exceeded maximum allowed size of ${maxBytes} bytes`,
                    ).diagnostic,
                  ),
                )
                return
              }
              controller.enqueue(value)
            }
          },
          cancel(reason) {
            cleanup()
            return streamReader.cancel(reason)
          },
        })
      },
    }
  }
}
