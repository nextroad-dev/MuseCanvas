// 创作台输入框 → Canvas Agent 结构化上下文。纯模块（仅 type import），可单测。
//
// 输入框只是「上下文作者」，不是第二条执行路径：它把意图/模型/参数/输入引用/
// 编辑来源打包进 `context`，交给同一个 POST-SSE 发送；不直接调用生成或局部修改接口。
// 每次请求都是 confirmation-gated + agent-managed：提案必须先经用户确认。

import type {
  AgentStreamEvent,
  CanvasAgentMessageRequest,
  CanvasAgentStructuredContext,
  CanvasAgentStructuredEditSource,
  CanvasAgentStructuredInputItem,
  EditSelection,
  JsonObject,
} from '@musecanvas/contracts'
import type { ParameterState } from '@/shared/types'

export type ComposerIntent = 'generate' | 'edit'

/** 编辑目标：assetId / nodeId 至少一个 + 源图像素选区。 */
export interface ComposerEditSource {
  assetId?: string
  nodeId?: string
  selection: EditSelection
}

export interface ComposerDraft {
  text: string
  intent: ComposerIntent
  /** 显式选择的模型；null 表示交给 Agent 决定。 */
  modelId: string | null
  parameters: ParameterState
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

function plainParameters(parameters: ParameterState): JsonObject {
  const output: JsonObject = {}
  for (const [key, value] of Object.entries(parameters)) output[key] = value
  return output
}

function editSourceContext(source: ComposerEditSource | null): CanvasAgentStructuredEditSource | undefined {
  if (!source) return undefined
  const assetId = source.assetId ?? ''
  const nodeId = source.nodeId ?? ''
  if (!assetId && !nodeId) return undefined
  return {
    ...(assetId ? { assetId } : {}),
    ...(nodeId ? { nodeId } : {}),
    selection: { ...source.selection },
  }
}

/** 组装 context：带选区时意图强制为 edit，避免「声称生成却带遮罩」。 */
export function buildComposerContext(draft: ComposerDraft): CanvasAgentStructuredContext {
  const editSource = editSourceContext(draft.editSource)
  const context: CanvasAgentStructuredContext = { intent: editSource ? 'edit' : draft.intent }
  const mutable = context as {
    intent?: ComposerIntent
    modelId?: string
    parameters?: JsonObject
    inputs?: CanvasAgentStructuredInputItem[]
    editSource?: CanvasAgentStructuredEditSource
  }
  if (draft.modelId) mutable.modelId = draft.modelId
  const parameters = plainParameters(draft.parameters)
  if (Object.keys(parameters).length > 0) mutable.parameters = parameters
  if (draft.inputs.length > 0) mutable.inputs = draft.inputs.map((item) => ({ ...item }))
  if (editSource) mutable.editSource = editSource
  return context
}

/** 构造一次 user turn 请求：始终要求确认、始终 agent-managed。 */
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

/** 显式「继续规划」：任务结束后的 job_event turn。 */
export function buildJobEventRequest(input: {
  messageId: string
  baseRevision: number
  jobId: string
}): CanvasAgentMessageRequest {
  return {
    kind: 'job_event',
    messageId: input.messageId,
    jobId: input.jobId,
    baseRevision: input.baseRevision,
    sceneCommitMode: 'agent-managed',
  }
}

/** `crypto.randomUUID()` 优先；缺失时退化（请求 messageId 需要 uuid 形状）。 */
export function newAgentMessageId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.()
  if (randomUuid) return randomUuid
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-8${hex().slice(1)}-${hex()}${hex()}${hex()}`
}

export type ComposerOutcome =
  | { status: 'done' }
  | { status: 'aborted' }
  | { status: 'error'; error: unknown }

export interface ComposerSenderHandlers {
  stream: (
    canvasId: string,
    request: CanvasAgentMessageRequest,
    signal: AbortSignal,
  ) => AsyncIterable<AgentStreamEvent>
  /** 首个 await 之前同步回调，用于乐观插入用户消息。 */
  onRequest?: (request: CanvasAgentMessageRequest, canvasId: string) => void
  onEvent: (event: AgentStreamEvent, canvasId: string) => void
  onSettled?: (outcome: ComposerOutcome, canvasId: string) => void
  newMessageId?: () => string
}

export interface SubmitLock {
  readonly locked: boolean
  tryLock(): boolean
  unlock(): void
}

export interface ComposerSender {
  readonly sending: boolean
  sendUserMessage(input: { canvasId: string; baseRevision: number; draft: ComposerDraft }): boolean
  sendJobEvent(input: { canvasId: string; baseRevision: number; jobId: string }): boolean
  stop(): void
}

/** 唯一的发送路径：同步占锁（防双击），onRequest 先于第一个 await 触发。 */
export function createComposerSender(handlers: ComposerSenderHandlers, lock: SubmitLock): ComposerSender {
  const nextId = handlers.newMessageId ?? newAgentMessageId
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
        const name = (error as { name?: unknown } | null)?.name
        outcome = name === 'AbortError' ? { status: 'aborted' } : { status: 'error', error }
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
      return dispatch(
        input.canvasId,
        buildComposerUserRequest({
          messageId: nextId(),
          baseRevision: input.baseRevision,
          draft: input.draft,
        }),
      )
    },
    sendJobEvent(input) {
      return dispatch(
        input.canvasId,
        buildJobEventRequest({
          messageId: nextId(),
          baseRevision: input.baseRevision,
          jobId: input.jobId,
        }),
      )
    },
    stop() {
      controller?.abort()
    },
  }
}
