// Agent Core V1 本地预览适配器（`WORKSPACE_MODE === 'mock'`）。
//
// 完全遵循 `@musecanvas/contracts` DTO 与状态流转，由 localStorage (`musecanvas:agent-preview:v1`)
// 持久化；生成产物只引用 `mock-workspace-data.ts` / `showcase.ts` 中的本地静态样片，绝不发起 `/api/*` 网络请求。

import type {
  AgentApprovalSummaryDTO,
  AgentDecimal,
  AgentEventEnvelope,
  AgentEventsPageDTO,
  AgentItemDTO,
  AgentItemsPageDTO,
  AgentMessageAcceptedDTO,
  AgentSessionDTO,
  AgentSessionSnapshotDTO,
  AgentSessionsPageDTO,
  AgentToolSummaryDTO,
  AgentTurnDTO,
  CreateAgentMessageRequest,
  CreateAgentSessionRequest,
  JsonObject,
  ResolveAgentApprovalRequest,
} from '@musecanvas/contracts'
import { ApiError } from './api'
import { mockSampleAsset } from './mock-workspace-data'
import { SHOWCASE_ITEMS } from '../lib/showcase'

export const MOCK_AGENT_STORAGE_KEY = 'musecanvas:agent-preview:v1'
export const MOCK_AGENT_OWNER_ID = '00000000-0000-4000-8000-000000000101'
export const MOCK_AGENT_DEFINITION_ID = '00000000-0000-4000-8000-000000000201'
export const MOCK_SEED_SESSION_ID = '00000000-0000-4000-8000-000000000401'
export const MOCK_AGENT_PLAN_MS = 600
export const MOCK_AGENT_EXECUTE_MS = 1_200

const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,18})$/
const HEX64_PATTERN = /^[0-9a-f]{64}$/
const APPROVAL_TTL_MS = 10 * 60_000

export interface MockAgentOptions {
  now?: () => number
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}

interface StoredTurn extends AgentTurnDTO {
  phase: 'planning' | 'awaiting_approval' | 'executing' | 'done'
  phaseAtMs: number
  prompt: string
}

interface StoredSessionRecord {
  session: AgentSessionDTO
  turns: Record<string, StoredTurn>
  items: AgentItemDTO[]
  tools: Record<string, AgentToolSummaryDTO>
  approvals: Record<string, AgentApprovalSummaryDTO>
  events: AgentEventEnvelope[]
  messageReceipts: Record<string, { digest: string; turnId: string; response: AgentMessageAcceptedDTO }>
}

interface StoredState {
  version: 1
  nextCounter: number
  sessionReceipts: Record<string, { digest: string; sessionId: string }>
  sessions: Record<string, StoredSessionRecord>
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message)
}

function mockUuid(prefixHex: string, counter: number): string {
  const prefix = prefixHex.replace(/[^0-9a-f]/gi, '').padEnd(4, '0').slice(0, 4).toLowerCase()
  const tail = counter.toString(16).padStart(12, '0').slice(-12)
  return `00000000-0000-4000-8${prefix.slice(0, 3)}-${tail}`
}

/** 生成确定性 64 位小写十六进制参数摘要（对齐后端 `^[0-9a-f]{64}$` 校验）。 */
function stableHex64(input: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0x94d049bb, 0xd6e8feb8]
  const hashes = seeds.slice()
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    for (let j = 0; j < hashes.length; j += 1) {
      let h = hashes[j]! ^ (code + i * (j + 1))
      h = Math.imul(h, 0x01000193)
      h ^= h >>> 15
      hashes[j] = h >>> 0
    }
  }
  return hashes.map((h) => h.toString(16).padStart(8, '0')).join('')
}

function incDecimal(value: AgentDecimal, delta = 1n): AgentDecimal {
  return (BigInt(value) + delta).toString() as AgentDecimal
}

function assertDecimal(value: string): AgentDecimal {
  if (!DECIMAL_PATTERN.test(value) || BigInt(value) > 9223372036854775807n) {
    fail(400, 'INVALID_INPUT', '无效的游标格式。')
  }
  return value as AgentDecimal
}

function assertLimit(limit: number | undefined, fallback = 50): number {
  const resolved = limit === undefined ? fallback : limit
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 100) {
    fail(400, 'INVALID_INPUT', '分页数量必须为 1–100。')
  }
  return resolved
}

function pickShowcaseIndex(seed: string): number {
  let acc = 0
  for (let i = 0; i < seed.length; i += 1) acc = (acc + seed.charCodeAt(i) * (i + 1)) % SHOWCASE_ITEMS.length
  return acc
}

function createInitialState(): StoredState {
  const seedCreatedAt = '2026-01-05T12:00:00.000Z'
  const seedUpdatedAt = '2026-01-05T12:00:05.000Z'
  const sample = SHOWCASE_ITEMS[0]!
  const sampleAsset = mockSampleAsset('00000000-0000-4000-8000-000000000901', 0, sample.prompt, seedUpdatedAt)
  const seedTurnId = '00000000-0000-4000-8000-000000000501'
  const seedToolId = '00000000-0000-4000-8000-000000000601'
  const seedApprovalId = '00000000-0000-4000-8000-000000000701'
  const seedArgs = { prompt: sample.prompt, size: `${sample.width}x${sample.height}` }
  const seedHash = stableHex64(JSON.stringify(seedArgs))

  const seedTurn: StoredTurn = {
    id: seedTurnId,
    sessionId: MOCK_SEED_SESSION_ID,
    status: 'completed',
    engineVersion: 'agent-core-v1',
    revision: '5',
    inputRevision: '1',
    cancelRequestedAt: null,
    terminalAt: seedUpdatedAt,
    deadlineAt: '2026-01-05T12:05:00.000Z',
    error: null,
    phase: 'done',
    phaseAtMs: Date.parse(seedUpdatedAt),
    prompt: sample.prompt,
  }

  const seedItems: AgentItemDTO[] = [
    {
      id: '00000000-0000-4000-8100-000000000001',
      sessionId: MOCK_SEED_SESSION_ID,
      turnId: seedTurnId,
      sequence: '1',
      type: 'user_message',
      toolCallId: null,
      payload: { content: '帮我创作一张晨雾水乡乌篷船写意参考样片' },
      createdAt: seedCreatedAt,
    },
    {
      id: '00000000-0000-4000-8100-000000000002',
      sessionId: MOCK_SEED_SESSION_ID,
      turnId: seedTurnId,
      sequence: '2',
      type: 'assistant_message',
      toolCallId: null,
      payload: { content: '我先梳理江南水乡的晨雾层次、水面倒影与乌篷船 3:4 构图参数，随后发起本地样片生成请求供你确认。' },
      createdAt: '2026-01-05T12:00:01.000Z',
    },
    {
      id: '00000000-0000-4000-8100-000000000003',
      sessionId: MOCK_SEED_SESSION_ID,
      turnId: seedTurnId,
      sequence: '3',
      type: 'tool_call',
      toolCallId: seedToolId,
      payload: {
        message: '准备调用 generate_image（本地样片预览）',
        toolName: 'generate_image',
        prompt: sample.prompt,
        size: `${sample.width}x${sample.height}`,
      },
      createdAt: '2026-01-05T12:00:02.000Z',
    },
    {
      id: '00000000-0000-4000-8100-000000000004',
      sessionId: MOCK_SEED_SESSION_ID,
      turnId: seedTurnId,
      sequence: '4',
      type: 'approval',
      toolCallId: seedToolId,
      payload: {
        message: '已确认生成晨雾水乡乌篷船本地样片',
        approvalId: seedApprovalId,
        toolName: 'generate_image',
      },
      createdAt: '2026-01-05T12:00:03.000Z',
    },
    {
      id: '00000000-0000-4000-8100-000000000005',
      sessionId: MOCK_SEED_SESSION_ID,
      turnId: seedTurnId,
      sequence: '5',
      type: 'tool_result',
      toolCallId: seedToolId,
      payload: {
        message: '本地样片已就绪（非真实模型推理）',
        toolName: 'generate_image',
        status: 'completed',
      },
      createdAt: '2026-01-05T12:00:04.000Z',
    },
    {
      id: '00000000-0000-4000-8100-000000000006',
      sessionId: MOCK_SEED_SESSION_ID,
      turnId: seedTurnId,
      sequence: '6',
      type: 'artifact_reference',
      toolCallId: seedToolId,
      payload: {
        message: `已生成样片参考：${sample.label}`,
        assetId: sampleAsset.id,
        url: sampleAsset.url,
        thumbnailUrl: sampleAsset.thumbnailUrl ?? sampleAsset.url,
        downloadUrl: sampleAsset.downloadUrl,
        width: sampleAsset.width ?? sample.width,
        height: sampleAsset.height ?? sample.height,
        mimeType: sampleAsset.mimeType,
        prompt: sampleAsset.prompt,
        label: sample.label,
      },
      createdAt: '2026-01-05T12:00:04.500Z',
    },
    {
      id: '00000000-0000-4000-8100-000000000007',
      sessionId: MOCK_SEED_SESSION_ID,
      turnId: seedTurnId,
      sequence: '7',
      type: 'assistant_message',
      toolCallId: null,
      payload: {
        content: '已完成「晨雾水乡的乌篷船」本地样片演示与执行记录整理。你可以继续输入新的灵感描述，或点击「新建」开启新对话。',
      },
      createdAt: seedUpdatedAt,
    },
  ]

  const seedEvents: AgentEventEnvelope[] = seedItems.map((item, idx) => ({
    schemaVersion: 1,
    eventId: `00000000-0000-4000-8200-${String(idx + 1).padStart(12, '0')}`,
    sessionId: MOCK_SEED_SESSION_ID,
    turnId: item.turnId,
    type: 'item.created',
    createdAt: item.createdAt,
    cursor: String(idx + 1) as AgentDecimal,
    itemSequence: item.sequence,
    entityRevision: null,
    payload: { item },
  }))

  const seedSession: AgentSessionDTO = {
    id: MOCK_SEED_SESSION_ID,
    ownerId: MOCK_AGENT_OWNER_ID,
    agentDefinitionId: MOCK_AGENT_DEFINITION_ID,
    definitionVersion: 1,
    defaultCanvasId: null,
    activeTurnId: null,
    inputRevision: '1',
    nextItemSequence: '8',
    nextEventCursor: '8',
    createdAt: seedCreatedAt,
    updatedAt: seedUpdatedAt,
    archivedAt: null,
  }

  return {
    version: 1,
    nextCounter: 10,
    sessionReceipts: {},
    sessions: {
      [MOCK_SEED_SESSION_ID]: {
        session: seedSession,
        turns: { [seedTurnId]: seedTurn },
        items: seedItems,
        tools: {
          [seedToolId]: {
            id: seedToolId,
            turnId: seedTurnId,
            toolName: 'generate_image',
            status: 'completed',
            revision: '5',
          },
        },
        approvals: {
          [seedApprovalId]: {
            id: seedApprovalId,
            sessionId: MOCK_SEED_SESSION_ID,
            turnId: seedTurnId,
            toolCallId: seedToolId,
            argumentsHash: seedHash,
            modelRevision: '1',
            pricingRevision: '1',
            reservationId: '00000000-0000-4000-8300-000000000001',
            status: 'approved',
            expiresAt: '2099-01-01T00:00:00.000Z',
            resolvedBy: MOCK_AGENT_OWNER_ID,
            resolvedAt: seedUpdatedAt,
            revision: '4',
          },
        },
        events: seedEvents,
        messageReceipts: {},
      },
    },
  }
}

function toPublicTurn(turn: StoredTurn): AgentTurnDTO {
  return {
    id: turn.id,
    sessionId: turn.sessionId,
    status: turn.status,
    engineVersion: turn.engineVersion,
    revision: turn.revision,
    inputRevision: turn.inputRevision,
    cancelRequestedAt: turn.cancelRequestedAt,
    terminalAt: turn.terminalAt,
    deadlineAt: turn.deadlineAt,
    error: turn.error,
  }
}

function isStoredStateValid(value: unknown): value is StoredState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const s = value as StoredState
  return (
    s.version === 1 &&
    Number.isSafeInteger(s.nextCounter) &&
    s.nextCounter >= 1 &&
    typeof s.sessions === 'object' &&
    s.sessions !== null &&
    typeof s.sessionReceipts === 'object' &&
    s.sessionReceipts !== null
  )
}

/** 构造隔离的本地 Mock Agent Core 引擎，支持注入时钟与存储以便确定性单测。 */
export function createMockAgentApi({ now = Date.now, storage }: MockAgentOptions = {}) {
  let state: StoredState = createInitialState()
  try {
    const raw = storage?.getItem(MOCK_AGENT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (isStoredStateValid(parsed)) {
        state = parsed
      }
    }
  } catch {
    // 存储不可用或损坏时自动回落到隔离的初始演示状态。
  }

  const listeners = new Map<string, Set<() => void>>()

  function save() {
    try {
      storage?.setItem(MOCK_AGENT_STORAGE_KEY, JSON.stringify(state))
    } catch {
      // 隐私模式或配额满时保留内存态，不阻断演示流程。
    }
  }

  function notify(sessionId: string) {
    const subs = listeners.get(sessionId)
    if (!subs) return
    for (const listener of [...subs]) {
      try {
        listener()
      } catch {
        // 订阅方异常不影响引擎状态。
      }
    }
  }

  function nextId(prefix: string): string {
    const id = mockUuid(prefix, state.nextCounter++)
    return id
  }

  function appendEvent(
    record: StoredSessionRecord,
    turnId: string | null,
    type: AgentEventEnvelope['type'],
    payload: Record<string, unknown>,
    itemSequence: AgentDecimal | null,
    entityRevision: AgentDecimal | null,
    atIso: string,
  ): AgentEventEnvelope {
    const cursor = record.session.nextEventCursor
    record.session.nextEventCursor = incDecimal(cursor)
    record.session.updatedAt = atIso
    const envelope = {
      schemaVersion: 1 as const,
      eventId: nextId('e000'),
      sessionId: record.session.id,
      turnId,
      type,
      createdAt: atIso,
      cursor,
      itemSequence,
      entityRevision,
      payload,
    } as AgentEventEnvelope
    record.events.push(envelope)
    if (record.events.length > 500) {
      record.events = record.events.slice(-500)
    }
    return envelope
  }

  function appendItem(
    record: StoredSessionRecord,
    turnId: string | null,
    type: AgentItemDTO['type'],
    payload: JsonObject,
    toolCallId: string | null,
    atIso: string,
    entityRevision: AgentDecimal | null = null,
  ): AgentItemDTO {
    const sequence = record.session.nextItemSequence
    record.session.nextItemSequence = incDecimal(sequence)
    const item: AgentItemDTO = {
      id: nextId('1000'),
      sessionId: record.session.id,
      turnId,
      sequence,
      type,
      toolCallId,
      payload,
      createdAt: atIso,
    }
    record.items.push(item)
    appendEvent(record, turnId, 'item.created', { item }, sequence, entityRevision, atIso)
    return item
  }

  /** 根据时钟推进处于规划/执行中的模拟轮次；返回是否有状态变化。 */
  function advanceRecord(record: StoredSessionRecord): boolean {
    const activeTurnId = record.session.activeTurnId
    if (!activeTurnId) return false
    const turn = record.turns[activeTurnId]
    if (!turn) return false
    const nowMs = now()
    let changed = false

    // 1. 过期检查：pending 审批超时则自动转为 expired。
    for (const approval of Object.values(record.approvals)) {
      if (approval.turnId === turn.id && approval.status === 'pending' && Date.parse(approval.expiresAt) <= nowMs) {
        approval.status = 'expired'
        approval.resolvedAt = new Date(nowMs).toISOString()
        turn.revision = incDecimal(turn.revision)
        approval.revision = turn.revision
        appendEvent(record, turn.id, 'approval.required', { approval: copy(approval) }, null, turn.revision, approval.resolvedAt)
        changed = true
      }
    }

    // 2. planning 阶段：queued -> running -> tool_call + waiting_approval
    if (turn.phase === 'planning' && nowMs >= turn.phaseAtMs + MOCK_AGENT_PLAN_MS) {
      const stepIso = new Date(turn.phaseAtMs + MOCK_AGENT_PLAN_MS).toISOString()
      turn.status = 'running'
      turn.revision = incDecimal(turn.revision)
      appendEvent(record, turn.id, 'turn.updated', { turn: toPublicTurn(turn) }, null, turn.revision, stepIso)

      const sampleIdx = pickShowcaseIndex(turn.prompt)
      const sample = SHOWCASE_ITEMS[sampleIdx]!
      const sizeStr = `${sample.width}x${sample.height}`

      appendItem(
        record,
        turn.id,
        'assistant_message',
        { content: `我已为你构思画面细节，准备生成「${sample.label}」画幅本地样片。请在下方确认工具调用参数。` },
        null,
        stepIso,
        turn.revision,
      )

      const toolId = nextId('6000')
      const approvalId = nextId('7000')
      const argsJson = { prompt: turn.prompt, size: sizeStr, mode: 'local-showcase-preview' }
      const argsHash = stableHex64(JSON.stringify(argsJson))

      const tool: AgentToolSummaryDTO = {
        id: toolId,
        turnId: turn.id,
        toolName: 'generate_image',
        status: 'waiting_approval',
        revision: turn.revision,
      }
      record.tools[toolId] = tool
      appendItem(
        record,
        turn.id,
        'tool_call',
        {
          message: `请求调用 generate_image（${sizeStr} 本地样片）`,
          toolName: 'generate_image',
          prompt: turn.prompt,
          size: sizeStr,
        },
        toolId,
        stepIso,
        turn.revision,
      )
      appendEvent(record, turn.id, 'tool.updated', { tool: copy(tool) }, null, turn.revision, stepIso)

      const approval: AgentApprovalSummaryDTO = {
        id: approvalId,
        sessionId: record.session.id,
        turnId: turn.id,
        toolCallId: toolId,
        argumentsHash: argsHash,
        modelRevision: '1',
        pricingRevision: '1',
        reservationId: nextId('8000'),
        status: 'pending',
        expiresAt: new Date(nowMs + APPROVAL_TTL_MS).toISOString(),
        resolvedBy: null,
        resolvedAt: null,
        revision: incDecimal(turn.revision),
      }
      record.approvals[approvalId] = approval
      appendItem(
        record,
        turn.id,
        'approval',
        {
          message: '等待用户确认图像生成工具调用',
          approvalId,
          toolName: 'generate_image',
          prompt: turn.prompt,
        },
        toolId,
        stepIso,
        turn.revision,
      )

      turn.status = 'waiting_approval'
      turn.revision = incDecimal(turn.revision)
      approval.revision = turn.revision
      tool.revision = turn.revision
      appendEvent(record, turn.id, 'approval.required', { approval: copy(approval) }, null, turn.revision, stepIso)
      appendEvent(record, turn.id, 'turn.updated', { turn: toPublicTurn(turn) }, null, turn.revision, stepIso)
      turn.phase = 'awaiting_approval'
      changed = true
    }

    // 3. executing 阶段（用户批准后）：completed tool_result + artifact_reference + summary
    if (turn.phase === 'executing' && nowMs >= turn.phaseAtMs + MOCK_AGENT_EXECUTE_MS) {
      const doneIso = new Date(turn.phaseAtMs + MOCK_AGENT_EXECUTE_MS).toISOString()
      const sampleIdx = pickShowcaseIndex(`${turn.prompt}:${record.items.length}`)
      const sample = SHOWCASE_ITEMS[sampleIdx]!
      const asset = mockSampleAsset(`mock-agent-${state.nextCounter++}`, sampleIdx, turn.prompt, doneIso)

      const executingTool = Object.values(record.tools).find(
        (t) => t.turnId === turn.id && (t.status === 'executing' || t.status === 'waiting_approval'),
      )
      turn.revision = incDecimal(turn.revision)

      if (executingTool) {
        executingTool.status = 'completed'
        executingTool.revision = turn.revision
        appendEvent(record, turn.id, 'tool.updated', { tool: copy(executingTool) }, null, turn.revision, doneIso)
      }

      const toolCallId = executingTool?.id ?? null
      appendItem(
        record,
        turn.id,
        'tool_result',
        {
          message: '本地样片生成完成（非真实模型推理）',
          toolName: 'generate_image',
          status: 'completed',
        },
        toolCallId,
        doneIso,
        turn.revision,
      )

      appendItem(
        record,
        turn.id,
        'artifact_reference',
        {
          message: `已产出本地样片参考：${sample.label}`,
          assetId: asset.id,
          url: asset.url,
          thumbnailUrl: asset.thumbnailUrl ?? asset.url,
          downloadUrl: asset.downloadUrl,
          width: asset.width ?? sample.width,
          height: asset.height ?? sample.height,
          mimeType: asset.mimeType,
          prompt: asset.prompt,
          label: sample.label,
        },
        toolCallId,
        doneIso,
        turn.revision,
      )

      appendItem(
        record,
        turn.id,
        'assistant_message',
        {
          content: `已完成「${turn.prompt.slice(0, 48)}」的本地样片生成与参考归档，可直接在右侧产物面板或作品图库中查看与复用。`,
        },
        null,
        doneIso,
        turn.revision,
      )

      turn.status = 'completed'
      turn.terminalAt = doneIso
      turn.phase = 'done'
      record.session.activeTurnId = null
      appendEvent(record, turn.id, 'turn.updated', { turn: toPublicTurn(turn) }, null, turn.revision, doneIso)
      changed = true
    }

    if (changed) save()
    return changed
  }

  function findSession(sessionId: string): StoredSessionRecord {
    const record = state.sessions[sessionId]
    if (!record) fail(404, 'NOT_FOUND', 'Agent 会话不存在。')
    advanceRecord(record)
    return record
  }

  function findTurn(turnId: string): { record: StoredSessionRecord; turn: StoredTurn } {
    for (const record of Object.values(state.sessions)) {
      const found = record.turns[turnId]
      if (found) {
        advanceRecord(record)
        return { record, turn: found }
      }
    }
    fail(404, 'NOT_FOUND', 'Agent 轮次不存在。')
  }

  const agent = {
    listSessions: async (params?: { limit?: number; cursor?: string }): Promise<AgentSessionsPageDTO> => {
      const limit = assertLimit(params?.limit, 50)
      for (const record of Object.values(state.sessions)) advanceRecord(record)
      const ordered = Object.values(state.sessions)
        .map((r) => r.session)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      let start = 0
      if (params?.cursor) {
        const idx = ordered.findIndex((s) => s.id === params.cursor)
        if (idx < 0) fail(404, 'NOT_FOUND', '分页会话游标不存在。')
        start = idx + 1
      }
      const slice = ordered.slice(start, start + limit)
      const hasMore = start + slice.length < ordered.length
      return copy({
        sessions: slice,
        nextCursor: hasMore ? (slice.at(-1)?.id ?? null) : null,
      })
    },

    createSession: async (body: CreateAgentSessionRequest): Promise<AgentSessionDTO> => {
      if (!body || typeof body.clientRequestId !== 'string' || !body.clientRequestId.trim()) {
        fail(400, 'INVALID_INPUT', '缺少 clientRequestId。')
      }
      if (typeof body.agentDefinitionId !== 'string' || !body.agentDefinitionId.trim()) {
        fail(400, 'INVALID_INPUT', '缺少 agentDefinitionId。')
      }
      if (!Number.isSafeInteger(body.definitionVersion) || body.definitionVersion < 1) {
        fail(400, 'INVALID_INPUT', '无效的 definitionVersion。')
      }
      const digest = stableHex64(
        JSON.stringify({
          agentDefinitionId: body.agentDefinitionId,
          definitionVersion: body.definitionVersion,
        }),
      )
      const existingReceipt = state.sessionReceipts[body.clientRequestId]
      if (existingReceipt) {
        if (existingReceipt.digest !== digest) {
          fail(409, 'CONFLICT', '会话请求标识已用于其他参数。')
        }
        const existing = state.sessions[existingReceipt.sessionId]
        if (existing) return copy(existing.session)
      }
      const ts = new Date(now()).toISOString()
      const sessionId = nextId('4000')
      const session: AgentSessionDTO = {
        id: sessionId,
        ownerId: MOCK_AGENT_OWNER_ID,
        agentDefinitionId: body.agentDefinitionId,
        definitionVersion: body.definitionVersion,
        defaultCanvasId: null,
        activeTurnId: null,
        inputRevision: '0',
        nextItemSequence: '1',
        nextEventCursor: '1',
        createdAt: ts,
        updatedAt: ts,
        archivedAt: null,
      }
      state.sessions[sessionId] = {
        session,
        turns: {},
        items: [],
        tools: {},
        approvals: {},
        events: [],
        messageReceipts: {},
      }
      state.sessionReceipts[body.clientRequestId] = { digest, sessionId }
      save()
      return copy(session)
    },

    getSnapshot: async (sessionId: string, params?: { limit?: number }): Promise<AgentSessionSnapshotDTO> => {
      const limit = assertLimit(params?.limit, 50)
      const record = findSession(sessionId)
      const activeTurn = record.session.activeTurnId ? record.turns[record.session.activeTurnId] ?? null : null
      const pageItems = record.items.slice(0, limit)
      const lastItemSeq =
        record.items.length > 0 ? record.items[record.items.length - 1]!.sequence : ('0' as AgentDecimal)
      const eventCursor =
        BigInt(record.session.nextEventCursor) > 0n
          ? incDecimal(record.session.nextEventCursor, -1n)
          : ('0' as AgentDecimal)
      const tools = activeTurn
        ? Object.values(record.tools).filter((t) => t.turnId === activeTurn.id)
        : []
      const approvals = activeTurn
        ? Object.values(record.approvals).filter((a) => a.turnId === activeTurn.id)
        : []

      return copy({
        session: record.session,
        activeTurn: activeTurn ? toPublicTurn(activeTurn) : null,
        items: pageItems,
        eventCursor,
        lastItemSequence: lastItemSeq,
        itemsHasMore: record.items.length > limit,
        nextItemsCursor: pageItems.at(-1)?.sequence ?? ('0' as AgentDecimal),
        tools,
        approvals,
        summariesTruncated: false,
      })
    },

    listItems: async (
      sessionId: string,
      params?: { cursor?: AgentDecimal; limit?: number },
    ): Promise<AgentItemsPageDTO> => {
      const limit = assertLimit(params?.limit, 50)
      const after = assertDecimal(params?.cursor ?? '0')
      const record = findSession(sessionId)
      if (BigInt(after) >= BigInt(record.session.nextItemSequence)) {
        fail(409, 'CURSOR_AHEAD', '分页游标超前。')
      }
      const filtered = record.items.filter((item) => BigInt(item.sequence) > BigInt(after))
      const page = filtered.slice(0, limit)
      const lastItemSequence =
        record.items.length > 0 ? record.items[record.items.length - 1]!.sequence : ('0' as AgentDecimal)
      return copy({
        items: page,
        nextCursor: page.at(-1)?.sequence ?? after,
        hasMore: filtered.length > limit,
        lastItemSequence,
      })
    },

    sendMessage: async (sessionId: string, body: CreateAgentMessageRequest): Promise<AgentMessageAcceptedDTO> => {
      if (!body || typeof body.clientMessageId !== 'string' || !body.clientMessageId.trim()) {
        fail(400, 'INVALID_INPUT', '缺少 clientMessageId。')
      }
      if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > 32_000) {
        fail(400, 'INVALID_INPUT', '消息内容须为 1–32000 字符。')
      }
      const record = findSession(sessionId)
      const digest = stableHex64(JSON.stringify({ sessionId, content: body.content }))
      const receipt = record.messageReceipts[body.clientMessageId]
      if (receipt) {
        if (receipt.digest !== digest) fail(409, 'CONFLICT', '消息请求标识已用于其他内容。')
        return copy(receipt.response)
      }
      if (record.session.archivedAt) fail(409, 'CONFLICT', '会话已归档。')

      const nowMs = now()
      const ts = new Date(nowMs).toISOString()
      let turn = record.session.activeTurnId ? record.turns[record.session.activeTurnId] : undefined
      if (turn && (turn.cancelRequestedAt || ['completed', 'failed', 'cancelled'].includes(turn.status))) {
        fail(409, 'CONFLICT', '当前轮次不可继续追加消息。')
      }

      const nextInputRevision = incDecimal(record.session.inputRevision)
      record.session.inputRevision = nextInputRevision

      if (!turn) {
        const turnId = nextId('5000')
        turn = {
          id: turnId,
          sessionId,
          status: 'queued',
          engineVersion: 'agent-core-v1',
          revision: '1',
          inputRevision: nextInputRevision,
          cancelRequestedAt: null,
          terminalAt: null,
          deadlineAt: new Date(nowMs + 120_000).toISOString(),
          error: null,
          phase: 'planning',
          phaseAtMs: nowMs,
          prompt: body.content.trim(),
        }
        record.turns[turnId] = turn
        record.session.activeTurnId = turnId
      } else {
        turn.inputRevision = nextInputRevision
        turn.revision = incDecimal(turn.revision)
        turn.prompt = `${turn.prompt}\n${body.content.trim()}`
      }

      appendItem(record, turn.id, 'user_message', { content: body.content }, null, ts, turn.revision)
      appendEvent(record, turn.id, 'turn.updated', { turn: toPublicTurn(turn) }, null, turn.revision, ts)

      const accepted: AgentMessageAcceptedDTO = {
        turn: toPublicTurn(turn),
        acceptedInputRevision: nextInputRevision,
      }
      record.messageReceipts[body.clientMessageId] = { digest, turnId: turn.id, response: accepted }
      save()
      notify(sessionId)
      return copy(accepted)
    },

    steerTurn: async (turnId: string, body: CreateAgentMessageRequest): Promise<AgentMessageAcceptedDTO> => {
      const { record, turn } = findTurn(turnId)
      if (turn.cancelRequestedAt || ['completed', 'failed', 'cancelled'].includes(turn.status)) {
        fail(409, 'CONFLICT', '当前轮次已结束或正在取消，无法追加引导。')
      }
      const accepted = await agent.sendMessage(record.session.id, body)
      const nowIso = new Date(now()).toISOString()
      appendItem(
        record,
        turn.id,
        'assistant_message',
        { content: `已记录你的补充指引：「${body.content.trim().slice(0, 100)}」，将在当前轮次中合并生效。` },
        null,
        nowIso,
        turn.revision,
      )
      save()
      notify(record.session.id)
      return accepted
    },

    getTurn: async (turnId: string): Promise<AgentTurnDTO> => {
      const { turn } = findTurn(turnId)
      return copy(toPublicTurn(turn))
    },

    cancelTurn: async (turnId: string): Promise<AgentTurnDTO> => {
      const { record, turn } = findTurn(turnId)
      if (['completed', 'failed', 'cancelled'].includes(turn.status) || turn.cancelRequestedAt) {
        return copy(toPublicTurn(turn))
      }
      const nowIso = new Date(now()).toISOString()
      turn.cancelRequestedAt = nowIso
      turn.terminalAt = nowIso
      turn.status = 'cancelled'
      turn.phase = 'done'
      turn.revision = incDecimal(turn.revision)
      if (record.session.activeTurnId === turn.id) {
        record.session.activeTurnId = null
      }
      for (const tool of Object.values(record.tools)) {
        if (tool.turnId === turn.id && !['completed', 'failed', 'cancelled', 'skipped'].includes(tool.status)) {
          tool.status = 'cancelled'
          tool.revision = turn.revision
          appendEvent(record, turn.id, 'tool.updated', { tool: copy(tool) }, null, turn.revision, nowIso)
        }
      }
      for (const approval of Object.values(record.approvals)) {
        if (approval.turnId === turn.id && approval.status === 'pending') {
          approval.status = 'expired'
          approval.resolvedAt = nowIso
          approval.revision = turn.revision
          appendEvent(record, turn.id, 'approval.required', { approval: copy(approval) }, null, turn.revision, nowIso)
        }
      }
      appendItem(record, turn.id, 'system_event', { message: '已取消当前执行轮次。' }, null, nowIso, turn.revision)
      appendEvent(record, turn.id, 'turn.updated', { turn: toPublicTurn(turn) }, null, turn.revision, nowIso)
      save()
      notify(record.session.id)
      return copy(toPublicTurn(turn))
    },

    resolveApproval: async (
      approvalId: string,
      body: ResolveAgentApprovalRequest,
    ): Promise<AgentApprovalSummaryDTO> => {
      if (
        !body ||
        (body.decision !== 'approved' && body.decision !== 'rejected') ||
        typeof body.expectedArgumentsHash !== 'string' ||
        !HEX64_PATTERN.test(body.expectedArgumentsHash)
      ) {
        fail(400, 'INVALID_INPUT', '无效的审批决定或摘要格式。')
      }

      let targetRecord: StoredSessionRecord | undefined
      let targetApproval: AgentApprovalSummaryDTO | undefined
      for (const record of Object.values(state.sessions)) {
        const candidate = record.approvals[approvalId]
        if (candidate) {
          targetRecord = record
          targetApproval = candidate
          break
        }
      }
      if (!targetRecord || !targetApproval) {
        fail(404, 'NOT_FOUND', '审批请求不存在。')
      }
      advanceRecord(targetRecord)

      const turn = targetRecord.turns[targetApproval.turnId]
      if (!turn) fail(404, 'NOT_FOUND', '关联轮次不存在。')
      if (targetApproval.argumentsHash !== body.expectedArgumentsHash) {
        fail(409, 'CONFLICT', '审批参数摘要与当前工具调用不一致。')
      }
      if (targetApproval.status !== 'pending') {
        if (targetApproval.status === 'expired') {
          fail(409, 'APPROVAL_EXPIRED', '审批已过期。')
        }
        if (targetApproval.status !== body.decision) {
          fail(409, 'CONFLICT', '该审批已完成其他操作。')
        }
        return copy(targetApproval)
      }
      if (['completed', 'failed', 'cancelled'].includes(turn.status) || turn.cancelRequestedAt) {
        fail(409, 'CONFLICT', '当前轮次已结束，无法处理审批。')
      }

      const nowMs = now()
      const nowIso = new Date(nowMs).toISOString()
      if (Date.parse(targetApproval.expiresAt) <= nowMs) {
        targetApproval.status = 'expired'
        targetApproval.resolvedAt = nowIso
        turn.revision = incDecimal(turn.revision)
        targetApproval.revision = turn.revision
        appendEvent(targetRecord, turn.id, 'approval.required', { approval: copy(targetApproval) }, null, turn.revision, nowIso)
        save()
        notify(targetRecord.session.id)
        fail(409, 'APPROVAL_EXPIRED', '审批已过期。')
      }

      turn.revision = incDecimal(turn.revision)
      targetApproval.status = body.decision
      targetApproval.resolvedBy = MOCK_AGENT_OWNER_ID
      targetApproval.resolvedAt = nowIso
      targetApproval.revision = turn.revision
      appendEvent(targetRecord, turn.id, 'approval.required', { approval: copy(targetApproval) }, null, turn.revision, nowIso)

      const tool = targetRecord.tools[targetApproval.toolCallId]
      if (body.decision === 'approved') {
        if (tool) {
          tool.status = 'executing'
          tool.revision = turn.revision
          appendEvent(targetRecord, turn.id, 'tool.updated', { tool: copy(tool) }, null, turn.revision, nowIso)
        }
        turn.status = 'waiting_tools'
        turn.phase = 'executing'
        turn.phaseAtMs = nowMs
        appendEvent(targetRecord, turn.id, 'turn.updated', { turn: toPublicTurn(turn) }, null, turn.revision, nowIso)
      } else {
        if (tool) {
          tool.status = 'cancelled'
          tool.revision = turn.revision
          appendEvent(targetRecord, turn.id, 'tool.updated', { tool: copy(tool) }, null, turn.revision, nowIso)
        }
        appendItem(
          targetRecord,
          turn.id,
          'tool_result',
          { message: '用户已拒绝本次工具调用', toolName: tool?.toolName ?? 'generate_image', status: 'cancelled' },
          tool?.id ?? null,
          nowIso,
          turn.revision,
        )
        appendItem(
          targetRecord,
          turn.id,
          'assistant_message',
          { content: '已取消本次图像生成。你可以修改描述或重新发起创作请求。' },
          null,
          nowIso,
          turn.revision,
        )
        turn.status = 'completed'
        turn.terminalAt = nowIso
        turn.phase = 'done'
        if (targetRecord.session.activeTurnId === turn.id) {
          targetRecord.session.activeTurnId = null
        }
        appendEvent(targetRecord, turn.id, 'turn.updated', { turn: toPublicTurn(turn) }, null, turn.revision, nowIso)
      }

      save()
      notify(targetRecord.session.id)
      return copy(targetApproval)
    },

    getEvents: async (
      sessionId: string,
      params?: { cursor?: AgentDecimal; limit?: number },
    ): Promise<AgentEventsPageDTO> => {
      const limit = assertLimit(params?.limit, 50)
      const after = assertDecimal(params?.cursor ?? '0')
      const record = findSession(sessionId)
      const high =
        BigInt(record.session.nextEventCursor) > 0n
          ? incDecimal(record.session.nextEventCursor, -1n)
          : ('0' as AgentDecimal)
      if (BigInt(after) > BigInt(high)) {
        fail(409, 'CURSOR_AHEAD', '事件游标超前。')
      }
      const events = record.events.filter((e) => BigInt(e.cursor) > BigInt(after))
      return copy({
        events: events.slice(0, limit),
        highWater: high,
        retentionFloor: '0' as AgentDecimal,
        hasMore: events.length > limit,
        resyncRequired: false,
      })
    },

    subscribe: (sessionId: string, listener: () => void): (() => void) => {
      let set = listeners.get(sessionId)
      if (!set) {
        set = new Set()
        listeners.set(sessionId, set)
      }
      set.add(listener)
      return () => {
        const current = listeners.get(sessionId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(sessionId)
      }
    },

    deleteSession: async (sessionId: string): Promise<{ deleted: boolean }> => {
      delete state.sessions[sessionId]
      for (const [reqId, receipt] of Object.entries(state.sessionReceipts)) {
        if (receipt.sessionId === sessionId) {
          delete state.sessionReceipts[reqId]
        }
      }
      listeners.delete(sessionId)
      save()
      return { deleted: true }
    },

    clearSessions: async (): Promise<{ cleared: boolean }> => {
      state.sessions = {}
      state.sessionReceipts = {}
      listeners.clear()
      save()
      return { cleared: true }
    },
  }

  return agent
}

export type MockAgentApiInstance = ReturnType<typeof createMockAgentApi>
export type MockAgentApi = MockAgentApiInstance

let browserInstance: MockAgentApiInstance | undefined

function browserMock(): MockAgentApiInstance {
  if (typeof window === 'undefined') {
    fail(400, 'MOCK_BROWSER_ONLY', '演示状态仅在浏览器内可用。')
  }
  if (!browserInstance) {
    let storage: Storage | undefined
    try {
      storage = window.localStorage
    } catch {
      // 浏览器禁用 localStorage 时降级为内存状态。
    }
    browserInstance = createMockAgentApi({ storage })
  }
  return browserInstance
}

/** 惰性浏览器门面：SSR 期间评估模块绝不会创建共享状态。 */
export const mockAgentApi: MockAgentApi = {
  listSessions: (params) => browserMock().listSessions(params),
  createSession: (body) => browserMock().createSession(body),
  getSnapshot: (sessionId, params) => browserMock().getSnapshot(sessionId, params),
  listItems: (sessionId, params) => browserMock().listItems(sessionId, params),
  sendMessage: (sessionId, body) => browserMock().sendMessage(sessionId, body),
  steerTurn: (turnId, body) => browserMock().steerTurn(turnId, body),
  getTurn: (turnId) => browserMock().getTurn(turnId),
  cancelTurn: (turnId) => browserMock().cancelTurn(turnId),
  resolveApproval: (approvalId, body) => browserMock().resolveApproval(approvalId, body),
  getEvents: (sessionId, params) => browserMock().getEvents(sessionId, params),
  subscribe: (sessionId, listener) => browserMock().subscribe(sessionId, listener),
  deleteSession: (sessionId) => browserMock().deleteSession(sessionId),
  clearSessions: () => browserMock().clearSessions(),
}
