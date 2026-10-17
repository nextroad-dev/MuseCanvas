import { CanvasErrorCode as C, type CreateGenerationRequest, type GenerationMode, type JsonValue, type ModelCapabilities } from '@musecanvas/contracts'
import { serializeCanonicalJson, validateGenerationRequest, type NormalizedGenerationRequest } from '@musecanvas/domain'
import { raise } from './config'

/** Derive the actual input intent, never the domain validator's legacy fallback. */
export function submissionMode(kind: 'image' | 'video', inputs: Array<{ role: string }>): GenerationMode {
  return kind === 'video' ? (inputs.length ? 'image_to_video' : 'text_to_video')
    : inputs.some(item => item.role === 'mask') ? 'inpaint' : inputs.length ? 'image_to_image' : 'text_to_image'
}

/** Legacy bundled manifests declare inpainting via flags plus their mask slot. */
export function supportsSubmissionMode(capabilities: ModelCapabilities, mode: GenerationMode): boolean {
  if (mode !== 'inpaint') return capabilities.modes.includes(mode)
  return capabilities.flags?.inpainting !== false && capabilities.flags?.mask !== false
    && capabilities.inputSlots.some(slot => slot.role === 'mask' && slot.maxCount > 0)
    && (capabilities.modes.includes('inpaint') || (capabilities.modes.includes('image_to_image') && capabilities.flags?.inpainting === true))
}

/** Visibility is evaluated before defaults. Freeze a validated fixed point so
 * generation's subsequent validation produces exactly this payload. */
export function normalizeSubmissionRequest(input: {
  capabilities: ModelCapabilities; defaults: Record<string, JsonValue>; request: CreateGenerationRequest
  kind: 'image' | 'video'; signal: AbortSignal; deadline: number
}): NormalizedGenerationRequest {
  const { capabilities, defaults, kind, signal, deadline } = input
  const mode = submissionMode(kind, input.request.inputs ?? [])
  if (!supportsSubmissionMode(capabilities, mode) || (mode === 'inpaint' && !(input.request.inputs ?? []).some(item => item.role === 'reference_image'))) raise(C.INVALID_INPUT)
  const check = () => {
    if (signal.aborted) raise(signal.reason === 'timeout' ? C.CANVAS_AGENT_TIMEOUT : C.CANVAS_AGENT_CANCELED, 409)
    if (Date.now() >= deadline) raise(C.CANVAS_AGENT_TIMEOUT, 409)
  }
  const maxPasses = Math.min(64, capabilities.parameters.length * 2 + 3)
  const seen = new Set<string>()
  let request = input.request, previous: string | undefined
  for (let pass = 0; pass < maxPasses; pass++) {
    check()
    const validation = validateGenerationRequest(capabilities, request, { defaults })
    check()
    if (!validation.valid || !validation.value) raise(C.INVALID_INPUT)
    const normalized = { ...validation.value, mode }
    const canonical = serializeCanonicalJson({ modelId: normalized.modelId, prompt: normalized.prompt,
      parameters: normalized.parameters, inputs: normalized.inputs, mode })
    if (canonical === previous) return normalized
    if (seen.has(canonical)) raise(C.INVALID_INPUT)
    seen.add(canonical); previous = canonical
    request = { ...request, prompt: normalized.prompt, parameters: normalized.parameters, inputs: normalized.inputs }
  }
  return raise(C.CANVAS_AGENT_BUDGET_EXCEEDED, 409)
}
