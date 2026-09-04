import type {
  BoundedOutput,
  ExecutionContext,
  MediaProviderManifest,
  MediaProviderPlugin,
  MediaRequest,
  OperationResult,
  OutputDescriptor,
  ProbeResult,
  ProviderConfig,
} from '../../core/types'
import { NormalizedProviderError } from '../../core/errors'

export const SEEDANCE_VIDEO_PLUGIN_ID = 'seedance-video'
export const SEEDANCE_VIDEO_PLUGIN_VERSION = '1.0.0'

export const SEEDANCE_CN_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
export const SEEDANCE_BYTEPLUS_BASE_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3'

const SEEDANCE_TASKS_PATH = '/contents/generations/tasks'

const DEFAULT_RETRY_AFTER_MS = 5_000
const MAX_RETRY_AFTER_MS = 30_000
const MAX_PROMPT_CHARS = 8_000
const MAX_INPUT_IMAGES = 4
const MAX_VIDEO_URL_CHARS = 4_096

export const SEEDANCE_IMAGE_ROLES = ['first_frame', 'last_frame', 'reference_image', 'mask'] as const
export type SeedanceImageRole = (typeof SEEDANCE_IMAGE_ROLES)[number]

export const seedanceVideoManifest: MediaProviderManifest = {
  id: SEEDANCE_VIDEO_PLUGIN_ID,
  version: SEEDANCE_VIDEO_PLUGIN_VERSION,
  displayName: 'Seedance 2.x Video Generation (Volcengine Ark / BytePlus)',
  modalities: ['video'],
  description: 'ByteDance Seedance async video generation via the Ark Contents generations tasks API',
  allowedHosts: ['ark.cn-beijing.volces.com', 'ark.ap-southeast.bytepluses.com'],
  credentialSchemas: ['legacy-api-key-v1', 'json-v1'],
  models: [
    { id: 'doubao-seedance-2-0-fast-260128', modalities: ['video'] },
    { id: 'dreamina-seedance-2-0-fast-260128', modalities: ['video'] },
  ],
}

type SeedanceContentEntry =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string }; role: SeedanceImageRole }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchesAllowedHost(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase()
  return patterns.some(pattern => {
    const p = pattern.toLowerCase()
    if (p.startsWith('*.')) {
      const suffix = p.slice(1)
      return host.endsWith(suffix) && host.length > suffix.length
    }
    return host === p
  })
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, Math.round(seconds * 1_000)))
}

function readExtra(config: ProviderConfig, key: string): unknown {
  if (config[key] !== undefined) return config[key]
  const extra = config.credential?.extra
  if (isRecord(extra) && extra[key] !== undefined) return extra[key]
  return undefined
}

export class SeedanceVideoPlugin implements MediaProviderPlugin {
  readonly manifest = seedanceVideoManifest

  async probe(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult> {
    const start = Date.now()
    try {
      this.validateConfig(config)
      const apiKey = this.resolveApiKey(config)
      const baseUrl = this.resolveBaseUrl(config)
      const res = await context.http.get(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        timeoutMs: config.timeoutMs ?? 15_000,
      })
      return { healthy: res.status < 500, latencyMs: Date.now() - start }
    } catch (err: unknown) {
      return {
        healthy: false,
        message: err instanceof Error ? err.message : 'Unknown probe error',
        latencyMs: Date.now() - start,
      }
    }
  }

  validateConfig(config: ProviderConfig): void {
    const apiKey = this.resolveApiKey(config)
    if (!apiKey) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'PROVIDER_NOT_CONFIGURED',
        'Seedance Ark API key is missing in provider config',
      )
    }
    for (const candidate of [config.baseUrl, config.credential?.baseUrl]) {
      if (candidate === undefined) continue
      let parsed: URL
      try {
        parsed = new URL(candidate)
      } catch {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_CONFIG',
          `Invalid baseUrl '${candidate}': not a valid URL`,
        )
      }
      if (parsed.protocol !== 'https:') {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_CONFIG',
          `Invalid baseUrl '${candidate}': must use https:`,
        )
      }
      if (!matchesAllowedHost(parsed.hostname, this.manifest.allowedHosts)) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_CONFIG',
          `Invalid baseUrl '${candidate}': host is not in the plugin allowlist`,
        )
      }
    }
  }

  validateRequest(request: MediaRequest, _config?: ProviderConfig): void {
    if (request.modality !== 'video') {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        `Seedance plugin supports video modality only, got '${request.modality}'`,
      )
    }
    if (!request.prompt || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'Prompt must be a non-empty string',
      )
    }
    if (request.prompt.length > MAX_PROMPT_CHARS) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        `Prompt exceeds maximum length of ${MAX_PROMPT_CHARS} characters`,
      )
    }
    if (!request.vendorModelId) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'vendorModelId is required',
      )
    }
    if (request.count !== undefined && (!Number.isInteger(request.count) || request.count < 1 || request.count > 4)) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'count must be an integer between 1 and 4',
      )
    }
    if (
      request.durationSeconds !== undefined &&
      (typeof request.durationSeconds !== 'number' ||
        !Number.isFinite(request.durationSeconds) ||
        request.durationSeconds < 1 ||
        request.durationSeconds > 30)
    ) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'durationSeconds must be a number between 1 and 30',
      )
    }
    const images = request.inputImages ?? []
    if (images.length > MAX_INPUT_IMAGES) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        `At most ${MAX_INPUT_IMAGES} input images are supported`,
      )
    }
    for (const img of images) {
      if (img.mimeType !== 'image/png' && img.mimeType !== 'image/jpeg') {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          `Unsupported input image mimeType '${img.mimeType}'`,
        )
      }
      const empty =
        (typeof img.data === 'string' && img.data.length === 0) ||
        (typeof img.data !== 'string' && img.data.length === 0)
      if (empty) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          'Input image data must be non-empty',
        )
      }
      if (img.sizeBytes !== undefined && img.sizeBytes > 20_000_000) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          'Input image exceeds maximum size of 20 MB',
        )
      }
    }
    const roles = request.extra?.['imageRoles']
    if (roles !== undefined) {
      if (!Array.isArray(roles) || roles.some(r => typeof r !== 'string' || !SEEDANCE_IMAGE_ROLES.includes(r as SeedanceImageRole))) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          `extra.imageRoles must be an array of [${SEEDANCE_IMAGE_ROLES.join(', ')}]`,
        )
      }
      if (roles.length !== images.length) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          'extra.imageRoles length must match inputImages length',
        )
      }
    }
    // Validate forwarded video controls early so submit never sends unvalidated values.
    this.extractVideoControls(request)
  }

  async submit(
    request: MediaRequest,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    this.validateRequest(request, config)

    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const endpoint = `${baseUrl}${SEEDANCE_TASKS_PATH}`

    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    }
    const clientRequestId = this.resolveClientRequestId(config)
    if (clientRequestId) headers['x-client-request-id'] = clientRequestId

    const response = await context.http.post(endpoint, JSON.stringify(this.buildGenerationsBody(request)), {
      headers,
      timeoutMs: config.timeoutMs,
    })

    if (!response.ok) {
      const errorText = await response.text()
      const normalized = NormalizedProviderError.fromHttp(
        this.manifest.id,
        this.manifest.version,
        response,
        errorText,
      )
      if (normalized.diagnostic.code === 'PROVIDER_TEMPORARY_ERROR') {
        return {
          status: 'submission_unknown',
          retryAfterMs: parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS,
          error: normalized.diagnostic,
        }
      }
      return { status: 'failed', error: normalized.diagnostic }
    }

    const json = (await response.json()) as unknown
    const id = isRecord(json) && typeof json['id'] === 'string' ? json['id'] : undefined
    if (!id) {
      return {
        status: 'submission_unknown',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'Seedance returned no task id',
          { providerReferenceId: this.providerReferenceId(response.headers) },
        ).diagnostic,
      }
    }

    return {
      status: 'waiting',
      remoteId: id,
      retryAfterMs: parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS,
      // Durable opaque state: JSON-safe identifiers only — never secrets or URLs.
      opaqueState: {
        taskId: id,
        model: request.vendorModelId,
        ...(request.durationSeconds !== undefined ? { durationSeconds: request.durationSeconds } : {}),
      },
    }
  }

  async poll(
    remoteId: string,
    opaqueState: Record<string, unknown> | undefined,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    if (!remoteId) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'remoteId is required for poll',
      )
    }
    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const endpoint = `${baseUrl}${SEEDANCE_TASKS_PATH}/${encodeURIComponent(remoteId)}`

    const response = await context.http.get(endpoint, {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.timeoutMs,
    })
    if (!response.ok) {
      const errorText = await response.text()
      const normalized = NormalizedProviderError.fromHttp(
        this.manifest.id,
        this.manifest.version,
        response,
        errorText,
      )
      if (normalized.diagnostic.code === 'PROVIDER_TEMPORARY_ERROR') {
        return {
          status: 'waiting',
          remoteId,
          opaqueState: opaqueState ?? { taskId: remoteId },
          retryAfterMs: parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS,
          error: normalized.diagnostic,
        }
      }
      return { status: 'failed', remoteId, error: normalized.diagnostic, opaqueState: opaqueState ?? { taskId: remoteId } }
    }

    const json = (await response.json()) as unknown
    const body: Record<string, unknown> = isRecord(json) ? json : {}
    const statusRaw = body['status'] ?? (isRecord(body['data']) ? body['data']['status'] : undefined)
    const status = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : ''
    const retryAfterMs = parseRetryAfterMs(response.headers) ?? DEFAULT_RETRY_AFTER_MS
    const state = opaqueState ?? { taskId: remoteId }

    if (status === 'queued' || status === 'running' || status === 'pending' || status === 'processing') {
      const progressRaw = body['progress']
      const progress =
        typeof progressRaw === 'number' && Number.isFinite(progressRaw)
          ? Math.min(100, Math.max(0, progressRaw))
          : undefined
      return { status: 'waiting', remoteId, progress, retryAfterMs, opaqueState: state }
    }

    if (status === 'succeeded' || status === 'completed') {
      const content = isRecord(body['content'])
        ? body['content']
        : isRecord(body['data']) && isRecord(body['data']['content'])
          ? (body['data']['content'] as Record<string, unknown>)
          : undefined
      const videoUrl = content && typeof content['video_url'] === 'string' ? content['video_url'] : undefined
      if (!videoUrl || videoUrl.length > MAX_VIDEO_URL_CHARS) {
        return {
          status: 'failed',
          remoteId,
          opaqueState: state,
          error: NormalizedProviderError.create(
            this.manifest.id,
            this.manifest.version,
            'PROVIDER_EMPTY_RESULT',
            'Seedance task succeeded but returned no video_url',
            { providerReferenceId: this.providerReferenceId(response.headers) },
          ).diagnostic,
        }
      }
      let parsed: URL
      try {
        parsed = new URL(videoUrl)
      } catch {
        return {
          status: 'failed',
          remoteId,
          opaqueState: state,
          error: NormalizedProviderError.create(
            this.manifest.id,
            this.manifest.version,
            'PROVIDER_REJECTED',
            'Seedance returned an invalid video_url',
          ).diagnostic,
        }
      }
      if (parsed.protocol !== 'https:' || !matchesAllowedHost(parsed.hostname, this.manifest.allowedHosts)) {
        return {
          status: 'failed',
          remoteId,
          opaqueState: state,
          error: NormalizedProviderError.create(
            this.manifest.id,
            this.manifest.version,
            'UNSAFE_URL',
            'Seedance returned a video_url outside the plugin host allowlist',
          ).diagnostic,
        }
      }
      const durationRaw = content?.['duration']
      const durationSeconds =
        (typeof durationRaw === 'number' && Number.isFinite(durationRaw) ? durationRaw : undefined) ??
        (typeof state['durationSeconds'] === 'number' ? (state['durationSeconds'] as number) : undefined)
      const outputs: OutputDescriptor[] = [
        {
          index: 0,
          mimeType: 'video/mp4',
          url: videoUrl,
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          metadata: { remoteId, model: state['model'] ?? body['model'] },
        },
      ]
      return { status: 'succeeded', remoteId, outputs, opaqueState: state }
    }

    if (status === 'cancelled' || status === 'canceled') {
      return {
        status: 'canceled',
        remoteId,
        opaqueState: state,
      }
    }

    if (status === 'failed') {
      return {
        status: 'failed',
        remoteId,
        opaqueState: state,
        error: this.taskFailureError(body, response),
      }
    }

    // Forward-compatible: unknown non-terminal provider statuses keep waiting.
    return { status: 'waiting', remoteId, retryAfterMs, opaqueState: state }
  }

  async cancel(
    remoteId: string,
    opaqueState: Record<string, unknown> | undefined,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    if (!remoteId) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'remoteId is required for cancel',
      )
    }
    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const endpoint = `${baseUrl}${SEEDANCE_TASKS_PATH}/${encodeURIComponent(remoteId)}`
    const state = opaqueState ?? { taskId: remoteId }

    const response = await context.http.request(endpoint, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.timeoutMs,
    })

    // Best-effort: a missing task is already terminal — treat as canceled.
    if (response.status === 404) {
      return { status: 'canceled', remoteId, opaqueState: state }
    }
    if (!response.ok) {
      const errorText = await response.text()
      const normalized = NormalizedProviderError.fromHttp(
        this.manifest.id,
        this.manifest.version,
        response,
        errorText,
      )
      return { status: 'failed', remoteId, error: normalized.diagnostic, opaqueState: state }
    }

    let status = ''
    try {
      const json = (await response.json()) as unknown
      const body: Record<string, unknown> = isRecord(json) ? json : {}
      const raw = body['status'] ?? (isRecord(body['data']) ? body['data']['status'] : undefined)
      if (typeof raw === 'string') status = raw.toLowerCase()
    } catch {
      // Some providers return an empty 200 on delete — that means canceled.
    }
    if (status === 'cancelled' || status === 'canceled' || status === '') {
      return { status: 'canceled', remoteId, opaqueState: state }
    }
    // Cancel accepted but still draining (canceling/cancelling/running): waiting is the canceling equivalent.
    return { status: 'waiting', remoteId, retryAfterMs: 3_000, opaqueState: state }
  }

  async openOutput(
    descriptor: OutputDescriptor,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<BoundedOutput> {
    if (!descriptor.mimeType || !descriptor.mimeType.startsWith('video/')) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        `Only video outputs can be opened, got mimeType '${descriptor.mimeType}'`,
      )
    }
    if (!descriptor.url) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'Output descriptor has no url to download',
      )
    }
    let parsed: URL
    try {
      parsed = new URL(descriptor.url)
    } catch {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'UNSAFE_URL',
        'Output url is not a valid URL',
      )
    }
    if (parsed.protocol !== 'https:' || !matchesAllowedHost(parsed.hostname, this.manifest.allowedHosts)) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'UNSAFE_URL',
        'Output url is not an HTTPS provider output in the plugin host allowlist',
      )
    }
    return context.readOutput(descriptor, {
      maxBytes: config.maxBytes,
      timeoutMs: config.timeoutMs,
    })
  }

  buildGenerationsBody(request: MediaRequest): Record<string, unknown> {
    const content: SeedanceContentEntry[] = [{ type: 'text', text: request.prompt }]
    const images = request.inputImages ?? []
    if (images.length > 0) {
      const roles = this.resolveImageRoles(request, images.length)
      for (let i = 0; i < images.length; i++) {
        const img = images[i]
        const mime = img.mimeType || 'image/png'
        const b64 = typeof img.data === 'string' ? img.data : img.data.toString('base64')
        content.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${b64}` },
          role: roles[i],
        })
      }
    }
    return {
      model: request.vendorModelId,
      content,
      ...this.extractVideoControls(request),
    }
  }

  private resolveImageRoles(request: MediaRequest, count: number): SeedanceImageRole[] {
    const explicit = request.extra?.['imageRoles']
    if (Array.isArray(explicit) && explicit.length === count) {
      return (explicit as string[]).map(r => r as SeedanceImageRole)
    }
    if (count === 1) return ['reference_image']
    if (count === 2) return ['first_frame', 'last_frame']
    const roles: SeedanceImageRole[] = ['first_frame']
    for (let i = 1; i < count - 1; i++) roles.push('reference_image')
    roles.push('last_frame')
    return roles
  }

  /**
   * Forwards only the validated video controls. Unknown extra keys are dropped
   * so undocumented provider combinations can never be sent implicitly.
   */
  private extractVideoControls(request: MediaRequest): Record<string, unknown> {
    const controls: Record<string, unknown> = {}
    const extra = request.extra ?? {}

    const takeBoolean = (key: string, fallback?: boolean) => {
      const value = extra[key] ?? fallback
      if (value === undefined) return
      if (typeof value !== 'boolean') {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          `Video control '${key}' must be a boolean`,
        )
      }
      controls[key] = value
    }

    const generateAudioRaw = extra['generate_audio'] ?? extra['audio']
    if (generateAudioRaw !== undefined) {
      if (typeof generateAudioRaw !== 'boolean') {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          "Video control 'generate_audio' must be a boolean",
        )
      }
      controls['generate_audio'] = generateAudioRaw
    }
    takeBoolean('camera_fixed')
    takeBoolean('watermark', request.watermark)

    if (extra['seed'] !== undefined) {
      const seed = extra['seed']
      if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > 2_147_483_647) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          "Video control 'seed' must be an integer between 0 and 2147483647",
        )
      }
      controls['seed'] = seed
    }

    if (extra['resolution'] !== undefined) {
      const resolution = extra['resolution']
      if (typeof resolution !== 'string' || (!/^[0-9]{3,4}p$/i.test(resolution) && !/^\d+x\d+$/.test(resolution))) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          "Video control 'resolution' must look like '720p', '1080p', or '1280x720'",
        )
      }
      controls['resolution'] = resolution
    }

    const ratioRaw = extra['ratio'] ?? extra['aspectRatio']
    if (ratioRaw !== undefined) {
      const ratio = ratioRaw
      if (typeof ratio !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(ratio)) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          "Video control 'ratio' must look like '16:9'",
        )
      }
      controls['ratio'] = ratio
    }

    const duration = extra['duration'] ?? request.durationSeconds
    if (duration !== undefined) {
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 1 || duration > 30) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          "Video control 'duration' must be a number between 1 and 30",
        )
      }
      controls['duration'] = duration
    }

    if (extra['frames'] !== undefined) {
      const frames = extra['frames']
      if (!Number.isInteger(frames) || (frames as number) < 1 || (frames as number) > 10_000) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_REQUEST',
          "Video control 'frames' must be an integer between 1 and 10000",
        )
      }
      controls['frames'] = frames
    }

    return controls
  }

  private resolveApiKey(config: ProviderConfig): string {
    if (config.credential?.apiKey) return config.credential.apiKey
    if (typeof config.apiKey === 'string' && config.apiKey) return config.apiKey as string
    return ''
  }

  private resolveBaseUrl(config: ProviderConfig): string {
    const explicit = config.credential?.baseUrl || config.baseUrl
    if (explicit) {
      const raw = explicit.replace(/\/$/, '')
      return raw.endsWith('/api/v3') ? raw : `${raw}/api/v3`
    }
    const regionRaw = readExtra(config, 'region')
    const region = typeof regionRaw === 'string' ? regionRaw.toLowerCase() : ''
    if (region === 'byteplus' || region === 'ap-southeast' || region.includes('byteplus')) {
      return SEEDANCE_BYTEPLUS_BASE_URL
    }
    return SEEDANCE_CN_BASE_URL
  }

  private resolveClientRequestId(config: ProviderConfig): string | undefined {
    for (const key of ['clientRequestId', 'clientToken', 'x-client-request-id']) {
      const value = readExtra(config, key)
      if (typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._~+/-]+$/.test(value)) {
        return value
      }
    }
    const header = config.customHeaders?.['x-client-request-id']
    if (typeof header === 'string' && header.length > 0 && header.length <= 128) return header
    return undefined
  }

  private providerReferenceId(headers: Headers): string | undefined {
    return (
      headers.get('x-request-id') ||
      headers.get('x-tt-logid') ||
      headers.get('x-volc-trace-id') ||
      undefined
    )
  }

  private taskFailureError(
    body: Record<string, unknown>,
    response: { headers: Headers },
  ) {
    const err = isRecord(body['error']) ? body['error'] : undefined
    const code = err && typeof err['code'] === 'string' ? (err['code'] as string) : undefined
    const message = err && typeof err['message'] === 'string' ? (err['message'] as string) : undefined
    const detail = `Seedance task failed${code ? ` [${code}]` : ''}${message ? `: ${message}` : ''}`
    return NormalizedProviderError.create(this.manifest.id, this.manifest.version, 'PROVIDER_REJECTED', detail, {
      providerReferenceId: this.providerReferenceId(response.headers),
    }).diagnostic
  }
}

export const seedanceVideoPlugin = new SeedanceVideoPlugin()
