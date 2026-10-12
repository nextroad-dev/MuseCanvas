// Structured composer draft -> Canvas Agent message context.
//
// The composer is a *context author*, never a second execution path: it assembles
// the JSON-safe `CanvasAgentStructuredContext` (intent / explicit model id /
// descriptor-built parameters / role-positioned inputs / edit source) and hands it
// to the same POST-SSE client the conversation already uses. Nothing here calls a
// generation or image-edit endpoint, and the submit lock is claimed synchronously
// so two activations in one tick cannot start two turns.
//
// `@musecanvas/contracts` is imported with `import type` only, so the framing can be
// exercised under plain `node --test` (the package's extensionless ESM cannot be
// resolved without tsx). The synchronous submit lock is injected by the caller as
// the same primitive `agent-stream.ts` exposes, so the composer and the hook share
// one guard rather than two.

import type {
  AgentStreamEvent,
  CanvasAgentMessageRequest,
  CanvasAgentStructuredContext,
  CanvasAgentStructuredEditSource,
  CanvasAgentStructuredInputItem,
  JsonObject,
} from '@musecanvas/contracts'
import type { ParameterState } from '@/shared/lib/media-parameters'

/** A user-authored turn is either fresh generation or an edit of an existing image. */
export type ComposerIntent = 'generate' | 'edit'

/** Edit target written by the result dialog: exactly one of assetId / nodeId. */
export interface ComposerEditSource {
  assetId?: string
  nodeId?: string
  selection: { x: number; y: number; width: number; height: number }
}

/** Everything the composer can express as Agent context constraints. */
export interface ComposerDraft {
  text: string
  intent: ComposerIntent
  /** Explicit model choice, or `null` to let the Agent decide. */
  modelId: string | null
  /** Descriptor-built parameters for `modelId`. */
  parameters: ParameterState
  /** Role-positioned inputs derived from the staged uploads/gallery picks. */
  inputs: CanvasAgentStructuredInputItem[]
  editSource: ComposerEditSource | null
}

export function createComposerDraft(overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return {
    text: '',
    intent: 'generate',
    modelId: null,
    parameters: {},
    inputs: [],
    editSource: null,
    ...overrides,
  }
}

/** A historical job's reusable configuration, as `buildJobConfigReuse` returns it. */
export interface ReusableJobConfig {
  prompt: string
  model: { id: string } | null
  parameters: ParameterState
}

/**
 * Seed a composer draft from a reused job configuration.
 *
 * Only the explicit facts a historical job can still vouch for are carried over —
 * the prompt, the chosen model id and the descriptor-built parameters. References
 * and any edit selection are deliberately cleared: a past job never restores them,
 * so keeping the current draft's would silently attach the wrong image. Nothing is
 * submitted; the caller still owns the send action.
 */
export function composerDraftFromJobConfig(reuse: ReusableJobConfig, previous: ComposerDraft): ComposerDraft {
  return {
    ...previous,
    text: reuse.prompt,
    intent: 'generate',
    modelId: reuse.model?.id ?? previous.modelId,
    parameters: { ...reuse.parameters },
    inputs: [],
    editSource: null,
  }
}

/** A plain JSON object, so a live `state` object is never leaked into the request. */
function plainParameters(parameters: ParameterState): JsonObject {
  const output: JsonObject = {}
  for (const [key, value] of Object.entries(parameters)) output[key] = value
  return output
}

function editSourceContext(source: ComposerEditSource | null): CanvasAgentStructuredEditSource | undefined {
  if (!source) return undefined
  const assetId = source.assetId ?? ''
  const nodeId = source.nodeId ?? ''
  // The server requires at least one identifier; a rectangle with neither is not a
  // valid edit source and is dropped rather than sent as an empty object.
  if (!assetId && !nodeId) return undefined
  return {
    ...(assetId ? { assetId } : {}),
    ...(nodeId ? { nodeId } : {}),
    selection: { ...source.selection },
  }
}

interface MutableContext {
  intent?: ComposerIntent
  modelId?: string
  parameters?: JsonObject
  inputs?: CanvasAgentStructuredInputItem[]
  editSource?: CanvasAgentStructuredEditSource
}

/**
 * Build the `context` bag for one request. `intent` is always present (an explicit
 * generate/edit choice), so the request never carries a context-less body.
 */
export function buildComposerContext(draft: ComposerDraft): CanvasAgentStructuredContext {
  const editSource = editSourceContext(draft.editSource)
  const context: MutableContext = {}
  // An attached rectangle implies the edit intent: the request must not claim
  // "generate" while carrying a selection.
  context.intent = editSource ? 'edit' : draft.intent
  if (draft.modelId) context.modelId = draft.modelId
  const parameters = plainParameters(draft.parameters)
  if (Object.keys(parameters).length > 0) context.parameters = parameters
  if (draft.inputs.length > 0) context.inputs = draft.inputs.map((item) => ({ ...item }))
  if (editSource) context.editSource = editSource
  return context as CanvasAgentStructuredContext
}

/**
 * Assemble one `CanvasAgentMessageRequest`. Every request this composer produces is
 * confirmation-gated and agent-managed: the client never commits a scene itself and
 * never lets the model execute a proposal without the user seeing it first.
 */
export function buildComposerUserRequest(input: {
  messageId: string
  baseRevision: number
  draft: ComposerDraft
}): CanvasAgentMessageRequest {
  return {
    kind: 'user',
    messageId: input.messageId,
    text: input.draft.text.trim(),
    baseRevision: input.baseRevision,
    requireConfirmation: true,
    sceneCommitMode: 'agent-managed',
    context: buildComposerContext(input.draft),
  }
}

/** `crypto.randomUUID()` when available, with a non-cryptographic fallback for
 *  environments without it (older test runners). */
export function newComposerMessageId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError'
}

export type ComposerOutcome =
  | { status: 'done' }
  | { status: 'aborted' }
  | { status: 'error'; error: unknown }

export interface ComposerSenderHandlers {
  /** Streams one request. Injected so the send path is testable without a server. */
  stream: (canvasId: string, request: CanvasAgentMessageRequest, signal: AbortSignal) => AsyncIterable<AgentStreamEvent>
  /** Called synchronously with the built request, before the first await. */
  onRequest?: (request: CanvasAgentMessageRequest, canvasId: string) => void
  /** Receives the canvas the dispatch belongs to, so a stale stream that outlives a
   *  conversation switch can never write into the new timeline. */
  onEvent: (event: AgentStreamEvent, canvasId: string) => void
  onSettled?: (outcome: ComposerOutcome, canvasId: string) => void
  newMessageId?: () => string
}

/** The synchronous submit guard `agent-stream.ts` owns. Structural so this module
 *  needs no runtime relative import (which `node --test` cannot resolve). */
export interface SubmitLock {
  readonly locked: boolean
  tryLock(): boolean
  unlock(): void
}

export interface ComposerSender {
  readonly sending: boolean
  /** Returns `false` synchronously when empty, already sending, or missing a canvas. */
  sendUserMessage(input: { canvasId: string; baseRevision: number; draft: ComposerDraft }): boolean
  /** Sends the explicit `job_event` continuation. Shares the one submit lock. */
  sendJobEvent(input: { canvasId: string; baseRevision: number; jobId: string }): boolean
  stop(): void
}

/**
 * The single send path for the Agent conversation.
 *
 * `sendUserMessage` / `sendJobEvent` claim the lock synchronously — before the
 * first `await` — so a click handler and a form submit in the same tick resolve the
 * same decision and only one request leaves the browser. `stop()` aborts the active
 * Agent turn only; it never touches a media job.
 */
export function createComposerSender(handlers: ComposerSenderHandlers, lock: SubmitLock): ComposerSender {
  const nextId = handlers.newMessageId ?? newComposerMessageId
  let controller: AbortController | null = null
  let sending = false

  function dispatch(canvasId: string, request: CanvasAgentMessageRequest): boolean {
    if (!canvasId) return false
    if (!lock.tryLock()) return false
    const active = new AbortController()
    controller = active
    sending = true
    handlers.onRequest?.(request, canvasId)
    void (async () => {
      let outcome: ComposerOutcome = { status: 'done' }
      try {
        for await (const event of handlers.stream(canvasId, request, active.signal)) {
          if (active.signal.aborted) break
          handlers.onEvent(event, canvasId)
        }
        if (active.signal.aborted) outcome = { status: 'aborted' }
      } catch (error) {
        outcome = isAbortError(error) ? { status: 'aborted' } : { status: 'error', error }
      } finally {
        if (controller === active) controller = null
        sending = false
        lock.unlock()
        handlers.onSettled?.(outcome, canvasId)
      }
    })()
    return true
  }

  return {
    get sending() {
      return sending
    },
    sendUserMessage(input) {
      if (input.draft.text.trim() === '') return false
      return dispatch(input.canvasId, buildComposerUserRequest({
        messageId: nextId(),
        baseRevision: input.baseRevision,
        draft: input.draft,
      }))
    },
    sendJobEvent(input) {
      return dispatch(input.canvasId, {
        kind: 'job_event',
        messageId: nextId(),
        jobId: input.jobId,
        baseRevision: input.baseRevision,
        sceneCommitMode: 'agent-managed',
      })
    },
    stop() {
      controller?.abort()
    },
  }
}
