import type {
  BoundedOutput,
  ExecutionContext,
  MediaInputImage,
  MediaProviderManifest,
  MediaProviderPlugin,
  MediaRequest,
  OperationResult,
  OutputDescriptor,
  ProbeResult,
  ProviderConfig,
} from '../../core/types'
import { MASK_INPUT_ROLE, MAX_MASK_BYTES } from '@musecanvas/contracts'
import type { JsonValue, MediaParameterIssue } from '@musecanvas/contracts'
import {
  GenerationErrorCode,
  evaluateCrossFieldConstraints,
  validateParameterValue,
} from '@musecanvas/contracts'
import type { MediaModelDeclaration } from '../../core/types'
import {
  OPENAI_IMAGE_LEGACY_ENDPOINT_MODELS,
  OPENAI_IMAGE_MODELS,
  OPENAI_IMAGE_SUPPORTED_MODELS as SUPPORTED_MODEL_IDS,
  openAiImageMaxBatchSize,
  openAiImageModelDeclaration,
} from './models'
import { NormalizedProviderError } from '../../core/errors'
import { inspectDecodedImageOutput } from '../../core/output-image'
import { validateInputImages } from '../../core/image-input'

export const OPENAI_IMAGE_PLUGIN_ID = 'openai-image'
export const OPENAI_IMAGE_PLUGIN_VERSION = '1.1.0'
export const LEGACY_OPENAI_IMAGE_PLUGIN_VERSION = '1.0.0'

const OPENAI_ALLOWED_HOSTS = [
  'api.openai.com',
  '*.openai.com',
  'oaidalleapiprodscus.blob.core.windows.net',
  '*.blob.core.windows.net',
]
const OPENAI_CREDENTIAL_SCHEMAS = ['legacy-api-key-v1', 'json-v1']

const MAX_PROMPT_CHARS = 8_000

// The per-model size/quality tables that used to live here are now the
// `capabilities` blocks in `./models.ts`, where the browser, the API and this
// adapter all read the same declaration.
export const OPENAI_IMAGE_SUPPORTED_MODELS = SUPPORTED_MODEL_IDS

/**
 * Project a model declaration into the manifest shape the host reads.
 *
 * The flat `supportedAspectRatios` / `maxBatchSize` / `maxInputImages` /
 * `supportsMask` fields are kept, but each is *derived* from the declaration
 * rather than written out again: `plugin-catalog.ts` and the mask plumbing still
 * read them, and a second hand-maintained copy is exactly the drift this change
 * is meant to end. They are marked `@deprecated` on the type and will go once
 * those readers move onto `capabilities`.
 *
 * `capabilities` is attached only on the active manifest. The legacy 1.0.0
 * object stays byte-comparable because revisions already pinned to it resolve
 * against its permissiveness, and tightening a published contract retroactively
 * would fail jobs that were valid when they were created.
 */
function projectManifestModel(
  model: MediaModelDeclaration,
  active: boolean,
): NonNullable<MediaProviderManifest['models']>[number] {
  const sizeDescriptor = model.capabilities?.parameters.find(entry => entry.name === 'size')
  const referenceSlot = model.capabilities?.inputSlots.find(slot => slot.role === 'reference_image')
  return {
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    modalities: model.modalities,
    ...(sizeDescriptor && sizeDescriptor.type === 'image-size'
      ? { supportedAspectRatios: sizeDescriptor.presets.map(preset => preset.value).filter(value => value !== 'auto') }
      : {}),
    maxBatchSize: openAiImageMaxBatchSize(model),
    ...(active ? { maxInputImages: referenceSlot?.maxCount ?? 0 } : {}),
    ...(active && model.capabilities?.flags?.mask === true ? { supportsMask: true } : {}),
    ...(active && model.capabilities ? { capabilities: model.capabilities } : {}),
    ...(active && model.defaults ? { defaults: model.defaults } : {}),
    ...(model.deprecated ? { deprecated: true } : {}),
    ...(model.deprecationNote ? { deprecationNote: model.deprecationNote } : {}),
  }
}

/**
 * Validate an incoming request against the model's declared contract, using the
 * same validator the browser and the API already ran.
 *
 * Re-running it here is deliberate rather than redundant: this is the last gate
 * before a vendor call, the plugin is the only component that knows the wire
 * consequences of a value, and a queued job can reach here carrying parameters
 * that bypassed the console entirely (a retry, a re-pinned revision, an import).
 */
function validateAgainstDeclaration(
  model: MediaModelDeclaration,
  request: MediaRequest,
): MediaParameterIssue[] {
  const capabilities = model.capabilities
  if (!capabilities) return []

  // The typed fields win over the parameter bag: they are what the queue has
  // always carried, while `parameters` is the newer channel for the extras.
  const sent: Record<string, JsonValue> = { ...(request.parameters ?? {}) }
  if (request.size !== undefined) sent.size = request.size
  if (request.quality !== undefined) sent.quality = request.quality
  if (request.count !== undefined) sent.count = request.count

  const issues: MediaParameterIssue[] = []
  const sentOnly: Record<string, JsonValue> = {}
  for (const descriptor of capabilities.parameters) {
    const raw = sent[descriptor.name]
    if (raw === undefined) {
      if (descriptor.required && descriptor.defaultValue === undefined) {
        issues.push({
          code: GenerationErrorCode.MISSING_REQUIRED_PARAMETER,
          message: `缺少必填参数 '${descriptor.name}'`,
          parameter: descriptor.name,
        })
      }
      continue
    }
    sentOnly[descriptor.name] = raw
    issues.push(...validateParameterValue(descriptor, raw))
  }

  // Combination rules see only what was actually sent. Materialising defaults
  // first would let a default collide with a user choice and report a violation
  // the caller never made.
  issues.push(...evaluateCrossFieldConstraints(capabilities.crossFieldConstraints, sentOnly))
  return issues
}

function buildManifest(version: string, active: boolean): MediaProviderManifest {
  return {
    kind: 'media',
    id: OPENAI_IMAGE_PLUGIN_ID,
    version,
    displayName: 'OpenAI Image Generation & Editing',
    modalities: ['image'],
    description: active
      ? 'OpenAI DALL-E / GPT Image generations and edits via the official API pinned to api.openai.com (compatible endpoints remain on legacy 1.0.0)'
      : 'OpenAI DALL-E / GPT Image generations and edits via official or compatible APIs',
    allowedHosts: [...OPENAI_ALLOWED_HOSTS],
    credentialSchemas: [...OPENAI_CREDENTIAL_SCHEMAS],
    models: OPENAI_IMAGE_MODELS.map(model => projectManifestModel(model, active)),
  }
}

export const openAiImageManifest: MediaProviderManifest = buildManifest(OPENAI_IMAGE_PLUGIN_VERSION, true)
export const legacyOpenAiImageManifest: MediaProviderManifest = buildManifest(LEGACY_OPENAI_IMAGE_PLUGIN_VERSION, false)

function invalidRequest(version: string, detail: string): NormalizedProviderError {
  return NormalizedProviderError.create(OPENAI_IMAGE_PLUGIN_ID, version, 'INVALID_REQUEST', detail)
}

function decodeInputImageBytes(img: MediaInputImage): Buffer {
  return typeof img.data === 'string' ? Buffer.from(img.data, 'base64') : img.data
}

function inputImageBytes(images: MediaInputImage[]): Buffer[] {
  return images.map(decodeInputImageBytes)
}

/**
 * Multipart part payload for one input image, in the byte view `Blob` wants.
 * Shared by `image[]` and `mask` so both forward exactly the bytes the caller
 * supplied, without a copy when the Buffer owns its whole `ArrayBuffer`.
 */
function inputImageBlob(img: MediaInputImage): Blob {
  const rawData = decodeInputImageBytes(img)
  const blobBytes = rawData.buffer instanceof ArrayBuffer
    ? new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength)
    : Uint8Array.from(rawData)
  return new Blob([blobBytes], { type: img.mimeType || 'image/png' })
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function endpointAuthHosts(endpoint: string): string[] {
  try {
    return [new URL(endpoint).hostname]
  } catch {
    return []
  }
}

export class OpenAiImagePlugin implements MediaProviderPlugin {
  readonly manifest = openAiImageManifest

  async probe(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult> {
    this.validateConfig(config)
    const start = Date.now()
    const baseUrl = this.resolveBaseUrl(config)
    const apiKey = this.resolveApiKey(config)
    const endpoint = `${baseUrl}/models`

    try {
      const res = await context.http.get(endpoint, {
        headers: { authorization: `Bearer ${apiKey}` },
        timeoutMs: config.timeoutMs ?? 15_000,
        allowedHosts: endpointAuthHosts(endpoint),
      })
      if (!res.ok) {
        const text = await res.text()
        return {
          healthy: false,
          message: `Probe failed with HTTP ${res.status}: ${text}`,
          latencyMs: Date.now() - start,
        }
      }
      return {
        healthy: true,
        latencyMs: Date.now() - start,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown probe error'
      return {
        healthy: false,
        message,
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
        'OpenAI API key is missing in provider config',
      )
    }

    const effectiveBase = config.credential?.baseUrl || config.baseUrl || 'https://api.openai.com'
    try {
      const u = new URL(effectiveBase)
      if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'api.openai.com') {
        throw new Error(`baseUrl host must be api.openai.com, got '${u.hostname}'`)
      }
    } catch (err: unknown) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_CONFIG',
        `Invalid baseUrl '${effectiveBase}': ${err instanceof Error ? err.message : ''}`,
      )
    }
  }

  validateRequest(request: MediaRequest): void {
    const version = this.manifest.version
    if (request.modality !== 'image') {
      throw invalidRequest(version, `Only image modality is supported, got '${request.modality}'`)
    }
    if (!request.prompt || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw invalidRequest(version, 'Prompt must be a non-empty string')
    }
    if (request.prompt.length > MAX_PROMPT_CHARS) {
      throw invalidRequest(version, `Prompt exceeds maximum length of ${MAX_PROMPT_CHARS} characters`)
    }

    const model = openAiImageModelDeclaration(request.vendorModelId)
    if (!model?.capabilities) {
      throw invalidRequest(
        version,
        `Unsupported model '${request.vendorModelId}'; supported models: ${OPENAI_IMAGE_SUPPORTED_MODELS.join(', ')}`,
      )
    }

    // Size, quality, count and every declared extra are checked against the
    // model's own descriptors, so `quality=max` on a model without that rung and
    // a custom size outside the geometry band both fail here with a message
    // naming the parameter — instead of as an opaque vendor 400.
    const declarationIssues = validateAgainstDeclaration(model, request)
    if (declarationIssues.length > 0) {
      throw invalidRequest(version, declarationIssues[0].message)
    }

    const images = request.inputImages ?? []
    // Read from the contract rather than from a model-name comparison: this is
    // what keeps dall-e-3 rejecting references without the plugin having to
    // know which ids those are.
    const maxReferenceImages
      = model.capabilities.inputSlots.find(slot => slot.role === 'reference_image')?.maxCount ?? 0
    if (images.filter(img => img.role !== MASK_INPUT_ROLE).length > maxReferenceImages) {
      throw invalidRequest(
        version,
        maxReferenceImages === 0
          ? `Model ${request.vendorModelId} does not support reference images or edits`
          : `Model ${request.vendorModelId} accepts at most ${maxReferenceImages} reference images`,
      )
    }

    // The edit mask rides the same `inputImages` array as the reference images
    // (that is how the worker forwards `generation_job_inputs.role`), but it is a
    // control channel rather than something the model looks at: it must be a PNG
    // of exactly the base image's dimensions, and it must never be pushed through
    // the generic input-image dimension/aspect rules below, which it does not
    // belong to. Every mask failure carries its own message so a bad mask is
    // never reported to the user as "Invalid input image".
    const maskImages = images.filter(img => img.role === MASK_INPUT_ROLE)
    const baseImages = images.filter(img => img.role !== MASK_INPUT_ROLE)

    if (maskImages.length > 1) {
      throw invalidRequest(
        version,
        `An edit request carries at most one mask, got ${maskImages.length} inputs with role '${MASK_INPUT_ROLE}'`,
      )
    }
    if (maskImages.length === 1) {
      const mask = maskImages[0]
      if (mask.mimeType !== 'image/png') {
        throw invalidRequest(
          version,
          `The edit mask must be a PNG with an alpha channel, got mimeType '${mask.mimeType}'`,
        )
      }
      const base = baseImages[0]
      if (!base) {
        throw invalidRequest(
          version,
          `An edit mask needs the image it masks; got role '${MASK_INPUT_ROLE}' with no base image`,
        )
      }
      // The mask is sent as-is: the vendor requires identical pixel dimensions, so
      // a dimension the caller never declared can only be guessed at. Rejecting
      // beats resizing on a guess and regenerating the wrong area.
      if (
        base.width === undefined ||
        base.height === undefined ||
        mask.width === undefined ||
        mask.height === undefined
      ) {
        throw invalidRequest(
          version,
          `The edit mask and its base image must both declare width and height (base ${String(base.width)}x${String(base.height)}, mask ${String(mask.width)}x${String(mask.height)})`,
        )
      }
      if (mask.width !== base.width || mask.height !== base.height) {
        throw invalidRequest(
          version,
          `The edit mask must match the base image dimensions exactly, got ${mask.width}x${mask.height} for a ${base.width}x${base.height} image`,
        )
      }
      if (mask.sizeBytes !== undefined && mask.sizeBytes > MAX_MASK_BYTES) {
        throw invalidRequest(
          version,
          `The edit mask exceeds the vendor limit of ${MAX_MASK_BYTES} bytes (declared ${mask.sizeBytes} bytes)`,
        )
      }
    }

    for (const img of baseImages) {
      if (img.mimeType !== 'image/png' && img.mimeType !== 'image/jpeg') {
        throw invalidRequest(version, `Unsupported input image mimeType '${img.mimeType}'`)
      }
    }
    try {
      validateInputImages(inputImageBytes(baseImages).map(data => ({ data })))
    } catch (err: unknown) {
      throw invalidRequest(
        version,
        `Invalid input image: ${err instanceof Error ? err.message : 'validation failed'}`,
      )
    }
  }

  async submit(
    request: MediaRequest,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    this.validateRequest(request)

    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const hasImages = Array.isArray(request.inputImages) && request.inputImages.length > 0

    const endpoint = `${baseUrl}/${hasImages ? 'images/edits' : 'images/generations'}`

    // Transport failures (temporary/timeout) propagate as thrown
    // NormalizedProviderError; only deterministic HTTP 4xx becomes failed.
    let response
    if (hasImages) {
      const form = this.buildEditFormData(request)
      response = await context.http.post(endpoint, form, {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        timeoutMs: config.timeoutMs,
        allowedHosts: endpointAuthHosts(endpoint),
      })
    } else {
      const body = JSON.stringify(this.buildGenerationBody(request))
      response = await context.http.post(endpoint, body, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        timeoutMs: config.timeoutMs,
        allowedHosts: endpointAuthHosts(endpoint),
      })
    }

    if (!response.ok) {
      const errorText = await response.text()
      const normalized = NormalizedProviderError.fromHttp(
        this.manifest.id,
        this.manifest.version,
        response,
        errorText,
      )
      if (normalized.diagnostic.code === 'PROVIDER_TEMPORARY_ERROR') {
        throw normalized
      }
      return {
        status: 'failed',
        error: normalized.diagnostic,
      }
    }

    type OpenAiResponsePayload = {
      data?: Array<{
        b64_json?: string
        url?: string
      }>
    }

    let json: OpenAiResponsePayload
    try {
      json = await response.json<OpenAiResponsePayload>()
    } catch {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'OpenAI returned an unreadable response payload',
        ).diagnostic,
      }
    }
    if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'OpenAI returned empty data array',
        ).diagnostic,
      }
    }

    const count = request.count || 1
    const outputs: OutputDescriptor[] = []
    for (const item of json.data) {
      const hasUrl = typeof item.url === 'string' && item.url.length > 0
      const hasB64 = typeof item.b64_json === 'string' && item.b64_json.length > 0
      if (hasUrl === hasB64) continue
      if (hasUrl && !isHttpsUrl(item.url as string)) continue
      outputs.push({
        index: outputs.length,
        mimeType: 'image/png',
        url: hasUrl ? (item.url as string) : undefined,
        b64Json: hasB64 ? (item.b64_json as string) : undefined,
      })
      if (outputs.length >= count) break
    }
    if (outputs.length === 0) {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'OpenAI returned no usable image outputs',
        ).diagnostic,
      }
    }

    return {
      status: 'succeeded',
      outputs,
    }
  }

  async openOutput(
    descriptor: OutputDescriptor,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<BoundedOutput> {
    const version = this.manifest.version
    const hasUrl = typeof descriptor.url === 'string' && descriptor.url.length > 0
    const hasB64 = typeof descriptor.b64Json === 'string' && descriptor.b64Json.length > 0
    if (hasUrl === hasB64) {
      throw invalidRequest(version, 'Output descriptor must contain exactly one of url or b64Json')
    }
    if (hasUrl && !isHttpsUrl(descriptor.url as string)) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        version,
        'UNSAFE_URL',
        'Output URL must use HTTPS',
      )
    }
    if (descriptor.mimeType !== 'image/png' && descriptor.mimeType !== 'image/jpeg') {
      throw invalidRequest(version, `Only PNG/JPEG outputs can be opened, got mimeType '${descriptor.mimeType}'`)
    }
    const output = await context.readOutput(descriptor, {
      maxBytes: config.maxBytes,
      timeoutMs: config.timeoutMs,
    })
    const decoded = await inspectDecodedImageOutput(output.data, output.mimeType, {
      pluginId: this.manifest.id,
      version,
    })
    return {
      ...output,
      mimeType: decoded.mimeType,
      width: decoded.width,
      height: decoded.height,
      sizeBytes: output.data.length,
    }
  }

  private resolveApiKey(config: ProviderConfig): string {
    if (config.credential?.apiKey) return config.credential.apiKey
    if (typeof config.apiKey === 'string' && config.apiKey) return config.apiKey
    return ''
  }

  private resolveBaseUrl(config: ProviderConfig): string {
    const raw = (config.credential?.baseUrl || config.baseUrl || 'https://api.openai.com').replace(
      /\/$/,
      '',
    )
    return raw.endsWith('/v1') ? raw : `${raw}/v1`
  }

  /**
   * The non-image wire fields, derived from what the model declares.
   *
   * A parameter is forwarded only if this model's contract advertises it, which
   * is what keeps the adapter honest in both directions: `input_fidelity` can
   * never ride along to a model that applies high fidelity automatically, and a
   * model that declares no `output_format` at all falls back to the legacy
   * `response_format` shape without the caller naming it.
   *
   * Shared by the JSON generation body and the multipart edit form so a
   * parameter appears on both endpoints or neither — one that renders in the
   * console but is dropped on the edit path is indistinguishable from a model
   * that never supported it.
   */
  private buildRequestFields(request: MediaRequest): Record<string, string | number> {
    const model = openAiImageModelDeclaration(request.vendorModelId)
    const descriptors = model?.capabilities?.parameters ?? []
    const descriptorFor = (name: string) => descriptors.find(entry => entry.name === name)
    /** Sent value, else the descriptor's own default, else nothing. */
    const pick = (name: string): string | number | undefined => {
      const descriptor = descriptorFor(name)
      if (!descriptor) return undefined
      const raw = request.parameters?.[name]
      if (typeof raw === 'string' || typeof raw === 'number') return raw
      if (typeof descriptor.defaultValue === 'string' || typeof descriptor.defaultValue === 'number') {
        return descriptor.defaultValue
      }
      return undefined
    }

    const fields: Record<string, string | number> = {
      model: request.vendorModelId,
      prompt: request.prompt,
      size: request.size || '1024x1024',
    }
    if (request.quality) fields.quality = request.quality

    if (OPENAI_IMAGE_LEGACY_ENDPOINT_MODELS.has(request.vendorModelId)) {
      // Reached through the pre-`output_format` contract: it answers with
      // `response_format` and takes exactly one image per call.
      fields.response_format = 'b64_json'
      fields.n = 1
      return fields
    }

    fields.n = request.count || 1
    // Forwarded only when this model actually declares the parameter, so a model
    // whose format support is unconfirmed keeps whatever default the vendor
    // applies instead of having one asserted on its behalf.
    const outputFormat = pick('output_format')
    if (outputFormat !== undefined) fields.output_format = outputFormat

    // Everything below is forwarded only when the caller actually chose it. These
    // are new parameters on a long-standing endpoint, so sending a declared
    // default that nobody asked for would change the shape of requests that work
    // today for no benefit — and a stale `background`/`input_fidelity` pair could
    // contradict a format the caller did choose.
    const background = request.parameters?.background
    if (descriptorFor('background') && typeof background === 'string') fields.background = background

    // Compression is only defined for lossy formats. The contract already hides
    // the control elsewhere; suppressing it here means a stale or hand-crafted
    // value cannot reach the vendor as a 400.
    const compression = request.parameters?.output_compression
    if ((fields.output_format === 'jpeg' || fields.output_format === 'webp')
      && descriptorFor('output_compression') && typeof compression === 'number') {
      fields.output_compression = compression
    }

    // Only the legacy model declares `input_fidelity`; the current ones apply
    // high fidelity automatically, so the descriptor test above is what keeps
    // this off a modern request rather than a list of model names.
    const fidelity = request.parameters?.input_fidelity
    if (descriptorFor('input_fidelity') && typeof fidelity === 'string') fields.input_fidelity = fidelity
    return fields
  }

  private buildGenerationBody(request: MediaRequest): Record<string, unknown> {
    return this.buildRequestFields(request)
  }

  private buildEditFormData(request: MediaRequest): FormData {
    const inputImages = request.inputImages || []
    // `image[]` is what the model sees, `mask` is where it may draw: the mask must
    // never land in `image[]`, and a request without one must produce the exact
    // same multipart body as before masks existed.
    const baseImages = inputImages.filter(img => img.role !== MASK_INPUT_ROLE)
    const maskImage = inputImages.find(img => img.role === MASK_INPUT_ROLE)
    const form = new FormData()
    const fields = this.buildRequestFields(request)
    for (const [key, value] of Object.entries(fields)) {
      // `response_format` is a generations-only legacy field; the edit endpoint
      // has always taken `output_format` instead.
      if (key === 'response_format') continue
      form.append(key, String(value))
    }

    for (let index = 0; index < baseImages.length; index++) {
      const img = baseImages[index]
      const mimeType = img.mimeType || 'image/png'
      const extension = mimeType === 'image/png' ? 'png' : 'jpg'

      form.append(
        'image[]',
        inputImageBlob(img),
        `reference-${index + 1}.${extension}`,
      )
    }

    if (maskImage) {
      form.append('mask', inputImageBlob({ ...maskImage, mimeType: 'image/png' }), 'mask.png')
    }

    return form
  }
}

/**
 * Legacy 1.0.0 OpenAI image plugin retained verbatim for already-pinned
 * revisions. New presets/revisions must use the active 1.1.0 plugin.
 */
export class LegacyOpenAiImagePlugin implements MediaProviderPlugin {
  readonly manifest = legacyOpenAiImageManifest

  async probe(config: ProviderConfig, context: ExecutionContext): Promise<ProbeResult> {
    const start = Date.now()
    const baseUrl = this.resolveBaseUrl(config)
    const apiKey = this.resolveApiKey(config)
    const endpoint = `${baseUrl}/models`

    try {
      const res = await context.http.get(endpoint, {
        headers: { authorization: `Bearer ${apiKey}` },
        timeoutMs: config.timeoutMs ?? 15_000,
      })
      if (!res.ok) {
        const text = await res.text()
        return {
          healthy: false,
          message: `Probe failed with HTTP ${res.status}: ${text}`,
          latencyMs: Date.now() - start,
        }
      }
      return {
        healthy: true,
        latencyMs: Date.now() - start,
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown probe error'
      return {
        healthy: false,
        message,
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
        'OpenAI API key is missing in provider config',
      )
    }

    if (config.baseUrl) {
      try {
        const u = new URL(config.baseUrl)
        if (u.protocol !== 'https:') {
          throw new Error('baseUrl must use https:')
        }
      } catch (err: unknown) {
        throw NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'INVALID_CONFIG',
          `Invalid baseUrl '${config.baseUrl}': ${err instanceof Error ? err.message : ''}`,
        )
      }
    }
  }

  validateRequest(request: MediaRequest): void {
    if (!request.prompt || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'Prompt must be a non-empty string',
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

    if (request.count !== undefined && (request.count < 1 || request.count > 10)) {
      throw NormalizedProviderError.create(
        this.manifest.id,
        this.manifest.version,
        'INVALID_REQUEST',
        'count must be between 1 and 10',
      )
    }
  }

  async submit(
    request: MediaRequest,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<OperationResult> {
    this.validateConfig(config)
    this.validateRequest(request)

    const apiKey = this.resolveApiKey(config)
    const baseUrl = this.resolveBaseUrl(config)
    const hasImages = Array.isArray(request.inputImages) && request.inputImages.length > 0

    const endpoint = `${baseUrl}/${hasImages ? 'images/edits' : 'images/generations'}`

    let response
    if (hasImages) {
      const form = this.buildEditFormData(request)
      response = await context.http.post(endpoint, form, {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        timeoutMs: config.timeoutMs,
      })
    } else {
      const body = JSON.stringify(this.buildGenerationBody(request))
      response = await context.http.post(endpoint, body, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        timeoutMs: config.timeoutMs,
      })
    }

    if (!response.ok) {
      const errorText = await response.text()
      const normalized = NormalizedProviderError.fromHttp(
        this.manifest.id,
        this.manifest.version,
        response,
        errorText,
      )
      return {
        status: 'failed',
        error: normalized.diagnostic,
      }
    }

    type OpenAiResponsePayload = {
      data?: Array<{
        b64_json?: string
        url?: string
      }>
    }

    const json = await response.json<OpenAiResponsePayload>()
    if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
      return {
        status: 'failed',
        error: NormalizedProviderError.create(
          this.manifest.id,
          this.manifest.version,
          'PROVIDER_EMPTY_RESULT',
          'OpenAI returned empty data array',
        ).diagnostic,
      }
    }

    const count = request.count || 1
    const sliced = json.data.slice(0, count)

    const outputs: OutputDescriptor[] = sliced.map((item, index) => ({
      index,
      mimeType: 'image/png',
      url: item.url,
      b64Json: item.b64_json,
    }))

    return {
      status: 'succeeded',
      outputs,
    }
  }

  async openOutput(
    descriptor: OutputDescriptor,
    config: ProviderConfig,
    context: ExecutionContext,
  ): Promise<BoundedOutput> {
    return context.readOutput(descriptor, {
      maxBytes: config.maxBytes,
      timeoutMs: config.timeoutMs,
    })
  }

  private resolveApiKey(config: ProviderConfig): string {
    if (config.credential?.apiKey) return config.credential.apiKey
    if (typeof config.apiKey === 'string' && config.apiKey) return config.apiKey
    return ''
  }

  private resolveBaseUrl(config: ProviderConfig): string {
    const raw = (config.credential?.baseUrl || config.baseUrl || 'https://api.openai.com').replace(
      /\/$/,
      '',
    )
    return raw.endsWith('/v1') ? raw : `${raw}/v1`
  }

  private buildGenerationBody(request: MediaRequest): Record<string, unknown> {
    return {
      model: request.vendorModelId,
      prompt: request.prompt,
      size: request.size || '1024x1024',
      ...(request.quality ? { quality: request.quality } : {}),
      output_format: 'png',
      n: request.count || 1,
    }
  }

  private buildEditFormData(request: MediaRequest): FormData {
    const inputImages = request.inputImages || []
    const form = new FormData()
    form.append('model', request.vendorModelId)
    form.append('prompt', request.prompt)
    form.append('size', request.size || '1024x1024')
    form.append('output_format', 'png')
    form.append('n', String(request.count || 1))
    if (request.quality) {
      form.append('quality', request.quality)
    }

    for (let index = 0; index < inputImages.length; index++) {
      const img = inputImages[index]
      const mimeType = img.mimeType || 'image/png'
      const extension = mimeType === 'image/png' ? 'png' : 'jpg'
      const rawData =
        typeof img.data === 'string'
          ? Buffer.from(img.data, 'base64')
          : img.data
      const blobBytes = rawData.buffer instanceof ArrayBuffer
        ? new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength)
        : Uint8Array.from(rawData)

      form.append(
        'image[]',
        new Blob([blobBytes], { type: mimeType }),
        `reference-${index + 1}.${extension}`,
      )
    }

    return form
  }
}

export const openAiImagePlugin = new OpenAiImagePlugin()
export const legacyOpenAiImagePlugin = new LegacyOpenAiImagePlugin()
