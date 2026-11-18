# MuseCanvas Agent Core 剩余非 M5 实施计划（冻结契约与并发分工）

- 日期：2026-11-17
- 状态：并行实现、M5 快照集成及独立审查修复已落地，全仓本地代码验收通过；canonical 媒体提案创建/审批后执行的生产流程仍未接通。未执行迁移、未提交或推送。
- 基线：`D:/Project/MuseCanvas-agent-remaining`，分支 `feat/agent-core-remaining`，快照 `f55e9d4`
- 上游设计：`docs/agent-core-v1-design.md` §4–§8、§18
- 用户所有（本计划明确排除）：`D:/Project/MuseCanvas-agent-m5` 分支 `feat/agent-core-m5` 中的 controls / rollout / steering / cancel / approval / coordinator
- 本计划的目标不是“补完 M1–M4 文档”，而是把快照中**实际仍缺失的运行闭环**拆成可并行、可独立验收的窄切片

## 执行期父协调者修正（优先于下文旧冻结文本）

- 真实媒体工具不允许 `approval: never` 绕过审批。媒体 lane 的 `assertEffectAllowed` 必须使用同一 `AgentToolContext.sql` 校验已持久化审批绑定（arguments hash / model / pricing / reservation），效果前后验证；缺省实现拒绝。Runner required 工具同样通过显式注入 gate；M5 继续独占审批创建、控制与恢复策略。
- Backend 不实现 model/context/registry/readonly，全部由对应 lane 注入；工具模型名统一 `name__vN`。
- completed round checkpoint 为 `{text,toolCalls:[{id,name,arguments}],contentBlocks?}`；assistant Item `{content,toolCallIds?:内部UUID[]}`；每个工具一个 tool_call Item 和唯一最终 tool_result Item。结果 content 为 `JSON.stringify(result ?? error)`；上下文严格校验完整批次/顺序/配对，不忽略冲突。
- M5 已拥有 `agent-budget.ts`。Backend 内部同事务账本重命名 `agent-execution-budget.ts` / `createAgentExecutionBudgetRepository`；结算 details 始终写 quota。最终集成必须选择单一账本实现/适配，保留 unknown 不重试与并发额度释放语义。
- P5a `withTurnLease` 保持 running 前后守卫不变。批准独立 `transitionWithTurnLease`：SQL-only 回调前后守卫后，最终 CAS 与依赖校验完成 waiting/completed/failed，公开 revision/event、lease、active pointer 同提交；无 cancel/expiry/recovery 策略。
- 媒体 `edit_image` 仅接受预准备 source+mask inpaint；`0045_agent_media_preparations.sql` 为显式 opt-in 的可信蒙版准备身份，绑定 owner、源/蒙版 checksum、尺寸、版本和期限。普通 PNG 上传不能替代该身份。rectangle/brush staging 未提供。
- 已批准在 Worker、maintenance、API jobs、generation 删除与用户删除的实际终态事务追加完成事件，不改变原取消/删除策略。
- 用户确认 M5 已完成。其真实 worktree 快照（含 `0044`）已按共同基线三方合入集成工作树，源 M5 未修改、无新提交；运行时组合已通过独立复审与本地验收。

## 最终集成状态（优先于下文历史快照与 lane 分工）

默认 `main()` 已使用 `createProductionAgentComposition()`，在 bootstrap/schema gate 后装配数据库端口、每个 wake 独立的 Runner/固定语言模型/registry、媒体完成 handler 与同事务 settlement，以及媒体提案物化/批准后执行 seam。模型查库在执行期锁事务之外，强制 owner/session/turn/deadline 作用域；缺少持久审批的 raw 媒体调用被物化为 canonical 提案并进入 `waiting_approval`，不产生媒体任务。0042/0043/0045 实际列预检在 Redis、health 与调度前执行。消费者失败先取消并排空所有循环；协调器停止新 sweep 后等待当前事务完成。

媒体提案写入与审批执行：raw arguments 与 checkpoint 保持不可变；物化在同一条 fenced 事务内完成严格原始参数校验、钉住媒体 revision 与描述符强转、托管输入 checksum 与可信蒙版准备身份、`generationEffectBindingHash` 等值校验、零价 `free-v1` 定价、工具行→预留→审批→事件写入，失败整体回滚。审批通过后 `claimTurnLease` 可重新受领 `waiting_tools`/`waiting_approval` Turn，Runner 仅对带持久批准绑定的 canonical 行调用内部执行器；拒绝/过期生成唯一配对失败结果，不产生媒体任务，也不静默放行。canonical 行是内部实现：上下文装配将其与标记整体排除，媒体终态结果在同一事务镜像到 raw 调用，保证模型看到的是它自己发出的调用 + 唯一结果。零价预留按实际 0 结算，非零/未知价格仍保守记为 unknown。

Runner 与 M5 共用 reservation/usage 表、quota 归因和 unknown 语义；正常媒体事件与恢复扫描共用 `settleLinkedAgentMediaReservations`、唯一结果投影与完整依赖排队门。取消/超时保留不确定的模型用量，费用未知不伪造为 0，远端任务未终结不释放并发容量。M5/Runner 组合 3P1+3P2 经独立复核全部解决。对 M5 的必要兼容修复仅写入集成工作树，原 M5 文件不变。

最终根级命令均在 `D:/Project/MuseCanvas-agent-remaining` 执行：`pnpm test` **1708 passed / 0 failed / 0 skipped**（contracts74、observability5、domain33、database341、providers241、media-service26、Web192、Worker295、API501）；`pnpm typecheck`、`pnpm lint`（0 errors / 160 warnings）、`pnpm build`、`git diff --check` 均通过。真实 PG/Redis/Provider/browser 集成未执行；这里的 0 skipped 仅指根级单元套件，不能用于表述 opt-in 真实环境 fixture 通过。

收尾轮已完成：终态 Turn 的遗留媒体结算扫描（`settleAbandonedMedia`）、协调器初轮错误处理与健康进度、0044 恢复索引预检、集成 fixture 迁移头断言修正、runbook 0045 更新、Console 媒体结果解析与缩略图/深链、操作者 `scripts/agent-definition.ts` CLI（默认 dry-run，应用不自动 seed）。

剩余功能缺口：无数据库计价的 V1 使用共享零价常量 `free-v1`（迁移 0024 已移除计费）；若未来引入真实价格，需新增定价来源并把该常量替换为冻结的定价 revision，在此之前不得填写非零金额。可靠模型定价缺失时有限金额预算仍拒绝调用。媒体创建仍限于预准备 source+mask 的 inpaint；rectangle/brush/tool upload staging 与 artifact resolver 未实现。`agentPreparation:true` 的生产调用仍需由上传/编辑入口显式接入。两项 admission 开关继续默认关闭，不能把上述本地验收表述为真实环境验收完成。

## 1. 结论与冻结决策

### 1.1 当前真实缺口（不是 M1–M4 已完成）

快照已有 P1–P4 与 P5a：

- `packages/media-service` 已抽取非 HTTP 生成命令与图片编辑准备；
- `0041`–`0043` 已建立 Agent Core 表、预算账本、Outbox 隔离、控制面 receipt；
- `apps/api/src/modules/agent/*` 已提供 Session/Turn/Items/Events/Cancel/Approval resolve 控制面；
- `packages/database/src/repositories/agent-runtime.ts` 已提供 P5a Turn lease/fencing；
- `apps/web` 已有 Agent Console、真实 DTO/SSE 适配与 mock adapter。

但以下能力在快照中**不存在**：

1. `apps/worker/src/agent/` 没有任何 Runner、consumer、Registry、工具或结算代码；Worker 启动只消费 generation stream。
2. `media.job.completed` 只有契约、Outbox 路由和迁移表，没有 producer；Agent 侧也没有 consumer。
3. `agent_model_rounds`、`agent_tool_calls`、`agent_tool_job_links`、`agent_budget_reservations` 只有表结构，没有执行期仓储。
4. Console 没有真实会话深链；`library.detail` 路径 helper 存在但后端没有 `GET /api/library/:id`；初始时间线只取快照前 50 条并向“后续”翻页，长会话不会自动落到最新；mock 常量仍从生产组件直接导入。
5. 现有 P4 `cancel` 在不满足本地终态条件时只记录 cancel intent 与 wake；没有 Runner 收尾，因此“取消后不再提交新媒体”尚未闭环。M5 负责该控制语义。

因此本计划只做非 M5 的**执行闭环**：Runner + round/budget + 媒体工具 + 媒体终态事件 + Console 缺口。M5 的控制面、灰度、approval 与 coordinator 不在本计划内。

### 1.2 冻结决策

1. **共享端口只有一个文件**：`apps/worker/src/agent/ports.ts`，纯类型、无运行时、无 I/O。三个原工作区写入字节完全一致副本；新增的 `MuseCanvas-agent-language` / `MuseCanvas-agent-tools` 由父协调者复制，本阶段不写。
2. **Runner 不直接 import 语言/工具实现**。`runner.ts` 只依赖 `AgentModelPort`、`AgentContextPort`、`AgentToolRegistry`、`AgentToolSettlementPort`；具体实现在 Worker boot 集成点注入，避免并行编译被未落地文件阻塞。
3. **所有工具效果写在同一调用方持有的 fenced SQL 事务内**。工具拿到的是 `AgentToolContext.sql`，禁止 `BEGIN/COMMIT/ROLLBACK`；抛错即回滚 job、inputs、tool-job link、budget reservation 和 wake Outbox。
4. **媒体任务创建与预算预留同事务**。`generate_image`/`edit_image`/`generate_video` 先 `ctx.budget.reserve`，再 `createGenerationInTransaction(ctx.sql, prepared)`，再写 `agent_tool_job_links`；任何一步失败都不创建付费任务。
5. **媒体终态事件按持久终态身份去重**。dedupe key 使用 `jobId + completed_at::text` 的数据库原始精度；手动重试清空完成时间，新终态生成新身份。不能只用 jobId 或依赖会被重置的 attempt；`retry_wait` 不发完成事件。
6. **媒体事件消费者只在数据库 commit 后 ACK**。`agent_consumed_events`、ToolCall 最终结果、Tool result Item、Turn queued、wake Outbox 在同一事务；Redis 重投由该事务幂等消化。
7. **真实媒体效果必须经过持久审批**。模型侧 raw 工具声明 `approval: 'required'`，只产生 `APPROVAL_REQUIRED`。内部 `executeApprovedAgentMediaProposal` 接受已物化且批准的独立提案，同事务验证 fence、revision、输入、定价与 reservation；没有默认放行 gate。raw → canonical 的提案创建尚是显式集成缺口，不能宣称真实媒体审批闭环已启用。
8. **Console 深链使用 `/agent/sessions/<uuid>`**，位于现有认证 studio layout；资产卡片使用 owner-scoped `GET /api/library/:id`，无效 UUID 查询前返回统一 404；mock 分流、SSE 恢复与分页锁保持独立。
9. **允许新增已批准的 `0045`**，保留用户 M5 的真实 `0044`。迁移仅新增文件，不执行；全库迁移连续性必须在包含二者的真实集成基线上验证。

## 2. 证据索引（快照事实）

| 事实 | 证据 |
|---|---|
| Worker 没有 Agent 运行时代码 | `find apps/worker/src/agent` 为空；`apps/worker/src/index.ts` 只启动 `consume(processJob)` |
| Agent wake 已路由但无消费者 | `apps/worker/src/queue/outbox-routing.ts:AGENT_STREAM`；无 `apps/worker/src/agent/consumer.ts` |
| media 终态事件无 producer | `rg "media.job.completed"` 只命中契约、路由、迁移、测试；`apps/worker/src/jobs/index.ts` 无写入 |
| 媒体终态写点 | `jobs/index.ts:persistJobSuccess`、`persistJobFailure`、`persistPreRunFailure`、`persistCanceledRun`、`failRunTerminal` |
| 重试会重置执行周期 | `apps/api/src/modules/jobs/handlers.ts:121` 将 `attempt=0,started_at=NULL` |
| P5a 只到 lease | `packages/database/src/repositories/agent-runtime.ts:withTurnLease` 明确“不做终态化、waiting handoff、恢复协调” |
| 预算/round 表已存在 | `0041_agent_core.sql:agent_model_rounds/agent_tool_calls`；`0042_agent_ledgers_outbox_quarantine.sql:agent_tool_job_links/agent_budget_reservations/agent_consumed_events` |
| 控制面已有但无 Runner | `apps/api/src/modules/agent/service.ts`、`handlers.ts`；`apps/api/src/modules/agent/feature.ts` 默认关闭 |
| 资产详情 GET 缺失 | `routes.ts` 只有 `GET library`、`GET library/:id/download` 与 `DELETE library/:id`；`API_ENDPOINTS.library.detail` 已存在 |
| Console 无深链 | `AgentConsoleView` 只读写 Zustand `activeSessionId`；无 `session` query 解析 |
| Console 分页语义 | `useAgentConsole.loadOlderItems` 使用 `nextItemsCursor` 向后取；时间线按钮文案是“加载更多后续记录” |
| mock 常量泄漏到生产组件 | `agent-console-view.tsx` 直接 import `MOCK_SEED_SESSION_ID` 自 `mock-agent-api` |
| M5 当前未提交改动 | `MuseCanvas-agent-m5` 有 `0044_agent_recovery_indexes.sql`、`coordinator.ts`、rollout/feature 改动；本计划不触碰 |

## 3. 非目标

- 不实现 M5：cancel/steering/approval 执行与 resolver、rollout/admission 百分比、coordinator/recovery、旧入口灰度、回滚演练。
- 不退役旧 Canvas Agent、`canvas_agent_*` 表或旧 `runAgent`。
- 不修改 `0001`–`0043`，不创建虚构 `0044`；仅增加已批准的 `0045`，并集成用户已完成的真实 M5。
- 不新增第三方依赖；只允许必要的 workspace 依赖（见 §7.1）。
- 不启动 API/Worker/PostgreSQL/Redis，不调用 Provider，不部署，不提交/推送。
- 不做真实费用结算或计费域对接；预算只做 Turn 级执行账本。
- API/maintenance 的既有取消和删除策略保持原语义；仅补齐同事务完成事件。

## 4. 共享端口：`apps/worker/src/agent/ports.ts`

### 4.1 文件规则

- 只允许 `import type`；不得 import 任何运行时模块、数据库 client、Node API 或 `apps/*`。
- 不实现函数，不提供默认值，不写 TODO。
- 文件头注释即所有权说明；任何 lane 需要新增字段，先回到父协调者改这一份文件，再同步副本。

### 4.2 已冻结导出

| 导出 | 用途 |
|---|---|
| `AgentSqlClient` | 工具可用的最小 `query` 表面；不是事务句柄 |
| `AgentTransaction` | 调用方持有 BEGIN/COMMIT/ROLLBACK 的事务函数 |
| `AgentTurnScope` / `AgentFencedTurn` | owner/session/turn 与 P5a fence（lease owner、fencing token、expected input revision） |
| `AgentModelRoundRef` | round id、position、input revision |
| `AgentToolContext` | `scope`、`turn`、`round`、`toolCallId`、`sql`、`budget`、`signal` |
| `AgentTool` / `AgentToolRegistry` | 工具定义、执行方式、approval seam、预算策略、同步/媒体结果 |
| `AgentReadOnlyToolPorts` | `list_models` / `search_assets` / `get_asset` / `get_canvas` 的 owner-scoped 依赖 |
| `AgentModelPort` / `AgentModelConfig` / `AgentModelCredential` | Worker 语言模型调用边界；凭据不进入 Item 或日志 |
| `AgentContextPort` | 完整 turn 上下文构造，输入含 instructions 与上限 |
| `AgentBudgetReserveInput` / `AgentBudgetReservation` / `AgentToolBudgetPort` | 工具在 fenced 事务内的预算预留 |
| `AgentToolResultInput` / `AgentToolSettlementPort` / `AgentWakeIntent` | Tool result、Turn queued 与 wake Outbox 的同事务交接 |
| `AgentMediaCompletion` / `AgentMediaEventHandler` | `media.job.completed` 消费边界；返回 `ack/retry` |
| `AgentRunnerWake` / `AgentRunner` | wake 消息与单 Turn 执行入口 |

### 4.3 字节一致性

已写入并校验 SHA-256 一致：

- `D:/Project/MuseCanvas-agent-remaining/apps/worker/src/agent/ports.ts`
- `D:/Project/MuseCanvas-agent-media-loop/apps/worker/src/agent/ports.ts`
- `D:/Project/MuseCanvas-agent-workspace/apps/worker/src/agent/ports.ts`

哈希：`200f318365bf08c50dbd13ae9e6dbdc4a8f120ee9a31becc7cbb46e67b6cf6e8`

`MuseCanvas-agent-language` 与 `MuseCanvas-agent-tools` 不自行复制；父协调者在本阶段结束后复制同一文件。

## 5. 各 lane 的精确交付契约

### 5.1 Backend lane（Runner / round / budget / consumer / boot）

**独占写文件**

- `packages/database/src/repositories/agent-execution.ts` + test
- `packages/database/src/repositories/agent-rounds.ts` + test
- `packages/database/src/repositories/agent-budget.ts` + test
- `apps/worker/src/agent/runner.ts` + test
- `apps/worker/src/agent/consumer.ts` + test
- `apps/worker/src/agent/settlement.ts` + test
- `apps/worker/src/agent/tools/executor.ts` + test
- `apps/worker/src/agent/tools/canvas.ts`（如需 `apply_canvas_operations`）
- `apps/worker/src/index.ts`（最后一步接线）
- 上述文件的测试

**禁止写**

- `apps/worker/src/agent/model.ts`、`context.ts`
- `apps/worker/src/agent/tools/registry.ts`、`readonly.ts`
- `apps/worker/src/agent/tools/media.ts`、`media-events.ts`
- `packages/database/src/repositories/agent-media.ts`
- `apps/worker/src/jobs/index.ts`
- `packages/media-service/*`
- M5 的 `coordinator.ts`、feature/rollout、0044
- contracts 导出、`routes.ts`、`endpoints.ts`（lead 集成）

**数据库仓储 API（冻结名字）**

`agent-rounds.ts`

```ts
beginModelRound(client, input: {
  scope: AgentTurnScope
  position: number
  requestDigest: string
  inputRevision: AgentDecimal
  modelReferenceId: string
}): Promise<{ roundId: string; position: number }>

completeModelRound(client, input: {
  scope: AgentTurnScope
  roundId: string
  status: 'completed' | 'failed' | 'superseded'
  usage: JsonObject | null
  checkpoint: JsonObject | null
}): Promise<void>

recordToolCalls(client, input: {
  scope: AgentTurnScope
  roundId: string
  calls: Array<{
    providerCallId: string
    toolName: string
    toolSchemaVersion: number
    arguments: JsonObject
    argumentsHash: string
    idempotencyKey: string
  }>
}): Promise<Array<{ toolCallId: string; position: number }>>

markToolCallStatus(client, input: {
  scope: AgentTurnScope
  toolCallId: string
  from: readonly AgentToolCallStatus[]
  to: AgentToolCallStatus
}): Promise<boolean>
```

`agent-execution.ts`

```ts
loadExecutionState(client, scope): Promise<{
  turn: AgentTurnDTO
  config: JsonObject
  budget: AgentBudgetDTO
  items: AgentItemDTO[]
  pendingToolCalls: AgentToolCallDTO[]
}>

appendAssistantItem(client, input: { scope; content: string; toolCallIds?: string[] }): Promise<AgentItemDTO>

handoffTurn(client, input: { scope; to: 'waiting_tools' | 'waiting_approval' }): Promise<AgentTurnDTO>

finishTurn(client, input: { scope; status: 'completed' | 'failed' | 'cancelled'; error: AgentError | null }): Promise<AgentTurnDTO>

recordToolResult(client, input: AgentToolResultInput): Promise<AgentToolResultRecord>

queueIfDependenciesTerminal(client, scope: AgentTurnScope): Promise<AgentWakeIntent | null>
```

`agent-budget.ts`

```ts
reserveBudget(client, input: {
  scope: AgentTurnScope
  roundId?: string
  toolCallId?: string
  reserve: AgentBudgetReserveInput
  limit: AgentBudgetDTO
  nowMs: number
}): Promise<AgentBudgetReservation>

settleBudget(client, input: {
  scope: AgentTurnScope
  reservationId: string
  outcome: 'settled' | 'released' | 'unknown'
  usage?: { kind: 'estimated' | 'actual' | 'unknown'; amount: AgentDecimal; currency: string | null; details: JsonObject }
}): Promise<void>

readBudgetUsage(client, scope: AgentTurnScope): Promise<AgentBudgetUsage>
```

**关键约束**

- 所有方法接收调用方 `client`，不自行 `BEGIN/COMMIT`；锁序必须是 actor → Session → Turn → Tool → Approval → Reservation，与 P4/P5a 一致。
- `recordToolResult` 必须幂等：`agent_items_tool_result_once_uq` 是最后防线；重复调用返回 `{ recorded: false, finalResult: true }`，不追加 Item、不重复事件。
- `queueIfDependenciesTerminal` 必须检查整轮所有 ToolCall（含 rejected/expired approval 对应的错误结果）、所有 Approval、所有 Reservation 的已知终态；只有全部满足才 `waiting_tools/waiting_approval → queued`，同一事务写 `turn.updated` 与 `agent.turn.wake`。
- `handoffTurn`/`finishTurn` 与 `releaseTurnLease` 分开；释放 lease 不改变 status/active pointer。终态化与清空 `active_turn_id` 同事务。
- 预算 reserve 使用 `(turn_id, idempotency_key)` 去重；媒体 job 与 reservation 同事务；预算冲突必须抛错并回滚整个工具效果。

**Runner 流程（`runner.ts`）**

`createAgentRunner(dependencies): AgentRunner`，dependencies 至少包含：

```ts
{
  transaction: AgentTransaction
  leases: AgentRuntimeRepository
  rounds: AgentRoundRepository
  execution: AgentExecutionRepository
  budget: AgentBudgetRepository
  registry: AgentToolRegistry
  model: AgentModelPort
  context: AgentContextPort
  settlement: AgentToolSettlementPort
  now: () => number
  leaseDurationMs: number
}
```

`runTurn(wake)`：

1. `claimTurnLease`；失败/被占用直接返回（consumer ACK）。
2. 读快照与上下文；若 `cancelRequestedAt` 或 deadline 已过，释放 lease，不提交任何新效果（M5 收尾）。
3. 计算 round position；事务 A：`beginModelRound` + 预留 model call/token 预算；提交。
4. 事务外调用 `model.complete`，带 timeout/signal；租约续期失败立即 abort。
5. 事务 B（`withTurnLease`，expected input revision）：校验 revision/cancel/deadline；`completeModelRound`、`appendAssistantItem`、`recordToolCalls`。
6. 无 tool call：`finishTurn(completed)`；有 tool call：按 Registry 校验名称/版本/schema/allowlist；未知或非法参数写成 `failed` tool result，并继续补齐整轮。
7. 每个 ToolCall 用 `withTurnLease` 执行；`AgentToolContext` 注入同一 `client`、`budget`、round、toolCallId。同步完成写 result；媒体 pending 写 `waiting_external` + `handoffTurn(waiting_tools)`。
8. 若所有 ToolCall 已有最终结果且无媒体依赖，`queueIfDependenciesTerminal`；否则释放 lease，等待事件。
9. 循环直到 completed/failed/waiting；每轮消耗 `maxModelCalls`/`maxToolCalls`；超限或 deadline 用 `finishTurn(failed)` 收尾（若还能拿到 fence）。

**Consumer（`consumer.ts`）**

`startAgentConsumer({ signal, runner, onActivity })`：

- 独立 stream `muse:agent`、独立 group（不得复用 `GENERATION_GROUP`）、独立 blocking Redis connection；支持 `XAUTOCLAIM`、心跳 key、`signal` 退出。
- 解析字段 `eventId/sessionId/turnId/revision`；格式非法 ACK 并告警。
- `runTurn` 成功或明确“被占用/已终态”后 ACK；数据库异常不 ACK，交给重投。
- 不在此处做 coordinator 扫描；M5 负责。

**Boot（最后一步）**

- `apps/worker/src/index.ts` 在 schema preflight、Redis 连接、health 启动后，用 `Promise` 并行启动媒体 `consume(processJob)` 与 `startAgentConsumer`；共用一个 `AbortController`。
- Agent consumer 默认启动，不依赖 `AGENT_CORE_ENABLED`，这样关闭 admission 后已受理 Turn 仍能排空；M5 的 rollout 只控制新 admission。
- 不修改 `schema-preflight.ts` 的 0042 检查；M5 已在该文件加 0044 检查，集成时由 lead 合并。

**验收**

- `runner.test.ts`：无工具直接 completed；未知工具/非法参数只产生失败结果、不执行；pending media → waiting_tools；重复 result 只写一次；fence 失配回滚。
- `consumer.test.ts`：非法消息 ACK；DB 失败不 ACK；被占用 ACK。
- 仓储单测使用现有 fake SQL step 模式；不声称 PostgreSQL 并发已验证。
- `pnpm --filter @musecanvas/worker typecheck && test` 通过。

### 5.2 Media lane（媒体仓储 / 工具 / 终态事件）

**独占写文件**

- `packages/database/src/repositories/agent-media.ts` + test
- `apps/worker/src/agent/tools/media.ts` + test
- `apps/worker/src/agent/media-events.ts` + test
- `apps/worker/src/jobs/index.ts`（只改终态 producer 写点）+ `jobs/index.test.ts`
- `packages/media-service/src/commands/create-job.ts`：只做 `createGenerationInTransaction` 参数从 `pg.PoolClient` 收窄到 `SqlClient` 的类型修改（无运行时行为）
- 上述测试

**禁止写**

- Runner、consumer、settlement、executor、registry、readonly、model、context
- API/Web
- M5 文件
- `0044` 或任何 migration

**`agent-media.ts` API（冻结名字）**

```ts
linkToolToJob(client, input: {
  toolCallId: string
  sessionId: string
  turnId: string
  ownerId: string
  jobId: string
  position: number
  dependencyRole: 'output' | string
}): Promise<void>

loadMediaCompletion(client, jobId: string): Promise<{
  jobId: string
  status: JobStatus
  links: Array<{ toolCallId: string; sessionId: string; turnId: string; ownerId: string }>
  jobs: Array<{ jobId: string; status: JobStatus; assetIds: string[] }>
} | null>

consumeMediaCompletion(client, consumerName: string, eventId: string): Promise<boolean>
// true = first consumption; false = duplicate

enqueueMediaCompletion(client, input: {
  jobId: string
  retryCycle: string
  attempt: number
  status: 'succeeded' | 'failed' | 'canceled'
}): Promise<void>
```

**`tools/media.ts` API**

```ts
export function createMediaAgentTools(): AgentTool[]
```

工具名与执行方式：

| 工具 | execution | 关键行为 |
|---|---|---|
| `generate_image` | `media_async` | 校验 model/count/inputs；`prepareGeneration` + `createGenerationInTransaction`；写 job link；返回 `pending jobIds` |
| `edit_image` | `media_async` | 复用 `prepareImageEditCommand` + Worker storage ports；source asset owner/checksum/mask 校验；同一事务建 job/link |
| `generate_video` | `media_async` | 校验 image reference 属于 owner 且 ready；duration/mode/capability；同一事务建 job/link |

固定规则：

- 先 `ctx.budget.reserve`：`media_jobs`、`media_outputs`、`concurrent_media_jobs`，有可靠价格时再加 `estimated_cost`；idempotency key 形如 `media:${turnId}:${toolCallId}:${index}:${quota}`。
- `prepareGeneration` 只做事务内读取/纯规范化；`createGenerationInTransaction(ctx.sql, prepared)` 必须接受 `AgentSqlClient`（通过 media-service 类型收窄）。
- job 创建后按输出位置插入 `agent_tool_job_links`，`position` 从 0 连续；`dependency_role='output'`。
- 返回 `{ kind: 'pending', jobIds }` 前所有 job/link/reservation 已持久化；任何错误抛出，由 Runner 回滚并记录 failed tool result。
- 本阶段 `approval: 'never'`（见 §8 风险）；M5 接管后改策略并加审批分支。

**`media-events.ts` API**

```ts
export function createAgentMediaEventHandler(
  dependencies: AgentMediaEventDependencies,
): AgentMediaEventHandler
```

处理顺序（全部在同一 `dependencies.transaction` 内）：

1. `consumeMediaCompletion(client, 'agent-media-v1', eventId)`；duplicate → 返回 `ack`。
2. `loadMediaCompletion(client, jobId)`；无 links → `ack`（非 Agent 任务）；job 尚未终态 → `retry`，不伪造成功。
3. 对每个 link，读取该 ToolCall 的全部 linked jobs；只有全部 `succeeded|failed|canceled` 才构造最终 result（jobIds、逐 job 状态、assetIds、错误）。
4. `settlement.recordToolResult` 写一次最终 result；已存在则幂等。
5. `settlement.queueIfDependenciesTerminal`；返回 wake 只用于日志/测试，Outbox 已同事务写入。
6. 事务提交后返回 `ack`；任何异常返回 `retry`，不 ACK。

**`jobs/index.ts` 终态 producer**

在以下写点同事务调用 `enqueueMediaCompletion`：

- `persistJobSuccess`：`status='succeeded'` 更新后；
- `persistJobFailure`：`retryable=false`、实际写入 `failed` 后；
- `persistPreRunFailure`：最终非重试失败后；
- `persistCanceledRun`：`status='canceled'` 更新后；
- `failRunTerminal` 通过 `persistJobFailure` 覆盖，不重复写。

禁止：

- `retry_wait` 发终态事件；
- `persistJobSuccess` 因 `cancel_requested_at` 返回 false 时发成功事件；
- 只按 jobId 去重。

Dedupe key：

```text
media.job.completed:${jobId}:${retryCycle}:${attempt}:${status}
```

`retryCycle` 使用当前 job 行的 `started_at::text`（无 started_at 的本地终态使用 `completed_at::text` + 固定前缀）；`attempt` 使用当前行。`retryJob` 会重置 `started_at`，因此新周期不会与旧周期碰撞。

**验收**

- `agent-media.test.ts`：link 唯一、消费去重、非终态不结算、多 job 全部终态才结算。
- `media.test.ts`：预算冲突不建 job；job/link 与 reservation 同事务；owner 输入不匹配失败；重复执行同一工具不重复建 job。
- `media-events.test.ts`：重复事件只写一次 result；乱序/部分完成不提前唤醒；事务失败不 ack。
- `jobs/index.test.ts`：成功/最终失败/取消各写一次；`retry_wait` 不写；dedupe key 含 cycle/attempt/status。
- `pnpm --filter @musecanvas/worker typecheck && test` 通过。

### 5.3 Language lane（`model.ts` + `context.ts`）

**独占写文件**

- `apps/worker/src/agent/model.ts` + test
- `apps/worker/src/agent/context.ts` + test

**稳定导出**

```ts
// model.ts
export function createAgentModel(dependencies: AgentModelDependencies): AgentModelPort

// context.ts
export function createAgentContext(dependencies: AgentContextDependencies): AgentContextPort
```

**约束**

- `model.ts` 只包装现有 `callLanguageModelChat`；不引入 OpenAI Agents SDK/LangChain；不把私有 reasoning 写入 Item；不记录 credential、URL、上游 body。
- `model.ts` 通过 `dependencies.loadCredential` 取内部凭据；凭据撤销/禁用时抛出安全错误，不绕过当前安全策略。
- `context.ts` 从 `agent_items`/rounds 组装完整 turn；不切断 assistant tool call 与 tool result 对；`maxBytes`/`maxTurns` 按完整 turn 计算；只读事务由调用方注入。
- `context.ts` 不读取 legacy `canvas_agent_messages`；旧历史由 legacy adapter 处理，本阶段不混读。
- 不实现 token 级 streaming；完整响应后由 Runner 写 Item。

**验收**

- 无工具、单工具、多工具、跨 turn 的上下文测试；重复 provider call ID 不串；超限时丢弃整 turn 而不是半截。
- `model.test.ts` 用 fake `callLanguageModelChat`/credential；不发真实网络。
- `pnpm --filter @musecanvas/worker typecheck && test` 通过。

### 5.4 Read-only tools lane（`registry.ts` + `readonly.ts`）

**独占写文件**

- `apps/worker/src/agent/tools/registry.ts` + test
- `apps/worker/src/agent/tools/readonly.ts` + test

**稳定导出**

```ts
// registry.ts
export function createAgentToolRegistry(input: {
  tools: readonly AgentTool[]
  allowlist: readonly string[] // "name@vN"
}): AgentToolRegistry

// readonly.ts
export function createReadonlyAgentTools(ports: AgentReadOnlyToolPorts): AgentTool[]
```

**规则**

- 构造时校验：工具名/schemaVersion 唯一、allowlist 格式 `^[a-z][a-z0-9_.-]{0,99}@v[1-9][0-9]{0,3}$`、allowlist 中每个条目都能解析、重复/缺失直接抛错。
- `readonly.ts` 提供 `list_models`、`search_assets`、`get_asset`、`get_canvas`；全部 `execution: 'sync'`、`approval: 'never'`、预算为 0。
- 所有读取通过 `AgentReadOnlyToolPorts` 的 owner-scoped 方法；工具本身不再拼 SQL，不返回永久签名 URL。
- 参数校验 fail closed：额外字段、超深 JSON、未知关键字拒绝；结果有数量/字节上限。
- Registry 不执行工具；执行由 backend `tools/executor.ts` 负责。

**验收**

- 未注册工具、schemaVersion 不匹配、allowlist 缺失、重复工具名均拒绝。
- `search_assets`/`get_asset` 跨 owner 返回空/错误，不泄露存在性。
- `pnpm --filter @musecanvas/worker typecheck && test` 通过。

### 5.5 Frontend lane（Console 缺口 + 资产详情端点）

**独占写文件**

- `apps/web/src/features/agent-console/**`（组件/store/lib 及其测试）
- `apps/web/src/shared/hooks/useAgentConsole.ts` + 相关测试
- `apps/web/src/shared/services/client-api.ts`
- `apps/web/src/shared/services/mock-agent-api.ts` 与新增的 mock 常量文件
- `apps/api/src/modules/library/handlers.ts` 的 `getAsset` + `apps/api/src/modules/library/*.test.ts`（资产详情）
- 上述测试

**禁止写**

- `apps/api/src/router/routes.ts`、`packages/contracts/src/endpoints.ts`、`packages/contracts/src/agent/index.ts`（lead 集成）
- Worker、database、M5

**交付 1：真实会话深链**

- URL 参数 `?session=<uuid>`；解析后设置 `activeSessionId`，仅当 UUID 合法。
- 深链会话不在会话列表第一页时，仍允许通过 `getSnapshot` 加载；侧栏显示“当前会话”占位，不强行伪造列表项。
- 选择/新建会话时用 `history.replaceState` 更新 `session`，保留 `panel`/复用 query；不得触发整页导航。
- mock 模式仅允许 `MOCK_SEED_SESSION_ID` 的深链；live 模式不得自动 seed。
- 刷新页面、断开 SSE、API 重启后，从 snapshot cursor 继续，不从头创建 Turn。

**交付 2：稳定资产详情**

- 后端新增 `GET /api/library/:id`：owner-scoped，非 owner/不存在统一 404；复用 `libraryAssetDto` 的签名 URL/TTL；不返回最近 100 条 fallback。
- `client-api.libraryApi.detail(id)` 走 `API_ENDPOINTS.library.detail`；mock 模式走 mock 数据。
- Console 的 `artifact_reference` 卡片优先用 `assetId` 查询详情；无 `assetId` 时才使用已有安全展示 URL；失效资产显示占位，不伪造完成。
- 这是窄端点，不改 `library.list` 语义；lead 负责在 `routes.ts` 注册 GET。

**交付 3：cursor 语义修正**

- 现有 `loadOlderItems` 实际取 `sequence > nextItemsCursor`，即“后续”而非“更早”。重命名为 `loadLaterItems` / `hasLaterItems`，保留 `nextItemsCursor` 契约字段。
- 初始快照后若有 `itemsHasMore`，有界自动追到最新页（最多 10 页 / 500 条），再显示“加载更多后续记录”；避免长会话打开时停在最早 50 条。
- SSE 到达的新 Item 与分页结果按 `sequence` 去重并保序；`eventCursor` 独立推进，不被 items 分页覆盖。
- 不新增 `before` 参数、不改 contracts DTO；若产品要求“从最新往回翻”，另开契约变更，不在本切片。

**交付 4：mock 安全**

- 把 `MOCK_SEED_SESSION_ID` 移到不依赖完整 mock adapter 的小模块；生产组件不再从 `mock-agent-api` 直接 import。
- `WORKSPACE_MODE === 'mock'` 时禁止任何真实 `fetch`/mutation；`live` 时禁止调用 `mockAgentApi` 的写方法。
- 新增测试：live 模式 mock 写方法零调用；mock 模式 `fetch` 零调用；深链不会把 mock session 带入 live。
- 保留现有 `client-api` 的 build-time mode 判断，不引入运行时开关。

**验收**

- 深链、会话切换、刷新恢复测试；资产详情 owner 404 与签名 URL 测试；cursor 自动追页/去重测试；mock/live 隔离测试。
- `pnpm --filter @musecanvas/web typecheck && test`、`pnpm --filter @musecanvas/api typecheck && test` 通过。
- 不启动浏览器/E2E；组件测试沿用现有 `.test.mjs` loader 模式。

### 5.6 Lead 集成（不实现业务逻辑）

- `packages/database/src/index.ts` 导出 `agent-execution`、`agent-rounds`、`agent-budget`、`agent-media`。
- `apps/worker/package.json` 增加 `@musecanvas/domain: workspace:*`（Runner 需要 `canReserveAgentBudget`/`canResumeAgentTurn`/`isTerminalAgentToolCall`）；用 pnpm 同步 `pnpm-lock.yaml`，保证 frozen install 通过。
- `apps/api/src/router/routes.ts` 注册 `GET library/:id`；`API_ENDPOINTS.library.detail` 已存在，不改。
- 把 language/tools lane 文件复制到 media-loop/remaining/workspace 的同一路径；保证 `ports.ts` 字节一致。
- 在 `apps/worker/src/index.ts` 接入 `createAgentModel`/`createAgentContext`/`createAgentToolRegistry`/`createReadonlyAgentTools`/`createMediaAgentTools` 与 backend runner 的注入。
- 合并 M5 时只做 rebase/冲突解决；不把 M5 的 coordinator/rollout/0044 带入本计划验收。
- 最终运行全仓 typecheck/lint/test/build；记录真实 PG/Redis 未运行。

## 6. 端到端事务与事件顺序

```text
POST message
  -> P4: Turn queued + agent.turn.wake (same tx)

Agent consumer
  -> claim turn lease (fence+1)
  -> model round intent + model budget reserve (tx)
  -> LLM (outside tx)
  -> withTurnLease(tx):
       complete round
       assistant item
       tool calls
  -> withTurnLease(tx) per tool:
       media tool:
         budget reserve (media_jobs/outputs/cost)
         createGenerationInTransaction
         agent_tool_job_links
       result pending
  -> handoff waiting_tools + release lease

Media worker
  -> provider run / assets / outputs
  -> persistJobSuccess/Failure/Canceled
     + media.job.completed outbox (same tx)

Agent media consumer
  -> tx:
       agent_consumed_events (dedupe)
       load linked jobs/assets
       record final tool result item (once)
       waiting_tools -> queued + turn.updated + agent.turn.wake
  -> COMMIT
  -> Redis ACK

Agent consumer
  -> claim queued turn
  -> next model round with tool result
  -> completed
```

关键边界：

- 模型调用、Provider 提交、对象存储读写都在数据库事务外。
- 媒体 job、预算、link、Outbox 必须同事务；失败整体回滚。
- 媒体事件消费者不重新判断 Provider 结果，只读数据库权威状态。
- 任何旧 fence 的写入都会被 P5a `withTurnLease` 拒绝；M5 的 steering/cancel 只需复用该 fence。

## 7. 依赖、构建与集成前提

### 7.1 workspace 依赖

- Backend 需要 `@musecanvas/domain` 才能复用预算/状态规则；Worker 当前没有该依赖。由 lead 在 `apps/worker/package.json` 加 `workspace:*` 并同步 lockfile。
- 不新增第三方包；不引入 ajv/XYFlow/OpenAI Agents SDK。
- media-service 的 `createGenerationInTransaction` 参数从 `pg.PoolClient` 收窄到 `SqlClient`，只改类型；由 media lane 执行，lead 复核。

### 7.2 构建

- 新文件都在 `apps/worker/tsconfig.json` 的 `src/**/*.ts` 内，无需新 tsconfig。
- 新 DB 仓储由 `packages/database/src/index.ts` 导出后，API/Worker 才能通过包边界 import。
- 不改 Dockerfile：Worker 镜像已 COPY workspace 包；新增文件在已有目录内。若 lead 发现 Docker build 需要复制新包 manifest，再单独处理。

### 7.3 运行前置（不授权部署）

- `AGENT_CORE_ENABLED=true` 才开放 API 命名空间；`AGENT_CORE_ADMISSION_READY=true` 才受理新 Session/Turn。默认均关闭。
- 必须存在 active `agent_definitions` 与可用语言/媒体 model config；仓库不提供 seed/default（P4 决策），需运维/测试环境显式创建。
- Worker 启动后 agent consumer 默认阻塞读独立 stream；没有 wake 时不应影响媒体 consumer 健康。
- 真实 Provider/对象存储/Redis/PostgreSQL 验证是后续运维步骤，不属于本阶段。

## 8. 风险与未决前提

1. **Approval 语义**：本阶段媒体工具 `approval: 'never'`，只为在 M5 之前验证闭环；M5 接管前不得开启真实 admission。若父协调者要求本阶段即强制审批，需先决定 approval 创建/过期/拒绝语义，不能由 Runner 伪造。
2. **API cancel / maintenance cancel 不写 media 终态事件**：本计划只改 `jobs/index.ts` 的 Worker 终态写点；API `cancelJob` 的 queued/retry_wait 分支与 `maintenance.handleCancellations` 仍不会唤醒 Agent。M5 cancel 负责补齐；在此之前，API 本地取消的 Agent Turn 可能停在 waiting_tools，需协调器（M5）收尾。
3. **M5 冲突**：M5 分支已有 `0044_agent_recovery_indexes.sql`、`coordinator.ts`、`schema-preflight.ts` 改动；本计划不触碰。集成时必须 rebase，不能把 0044 当成剩余计划的一部分。
4. **真实数据库未验证**：P5a 的 PG fixture 已存在，但本阶段不连接 PostgreSQL/Redis；仓储单测只验证 SQL 形状/事务调用，不证明并发、锁、触发器或迁移有效。
5. **无 definition seed**：Runner 只有在测试/运维创建 definition 后才能运行；没有 definition 时只能验证编译与 fake 依赖。
6. **媒体编辑的存储端口**：`edit_image` 需要 Worker storage driver 与对象字节读取；若 media lane 发现现有 `prepareImageEditCommand` 端口不足，应暂停并回到父协调者，不得把 API storage 反向引入 Worker。
7. **Console 长会话**：自动追页上限 10 页/500 条是产品折中；超过后显示手动手动加载。若产品要求“打开即最新，向上翻历史”，需要新增 `before` 契约，另开切片。
8. **Worker 启动行为**：Agent consumer 默认启动会新增一条阻塞 Redis 连接；必须使用独立连接与独立 group，不能复用媒体消费者连接/组，否则 Agent idle 会拖住媒体消费。

## 9. 验收矩阵

### 9.1 本阶段（计划/端口）验收

- `pnpm --filter @musecanvas/worker typecheck` 通过（已执行）。
- 三份 `ports.ts` SHA-256 一致。
- `git diff --check` 通过。
- 无 migration、无 M5 文件、无服务启动、无提交。

### 9.2 各 lane 合并前验收

| Lane | 命令 | 必须证明 |
|---|---|---|
| Backend | `pnpm --filter @musecanvas/worker typecheck && pnpm --filter @musecanvas/worker test`；`pnpm --filter @musecanvas/database typecheck && test` | fence 失配回滚；重复 result 只写一次；waiting→queued 只在依赖齐备时发生；budget reserve 冲突回滚 |
| Media | 同上 + `pnpm --filter @musecanvas/media-service typecheck && test` | job/link/reservation 同事务；重复 event 不重复 result；retry_wait 不发终态；dedupe key 含 cycle/attempt |
| Language | `pnpm --filter @musecanvas/worker typecheck && test` | 完整 tool pair；不泄漏 credential；无真实网络 |
| Tools | 同上 | allowlist/版本/额外字段 fail closed；owner scope |
| Frontend | `pnpm --filter @musecanvas/web typecheck && test`；`pnpm --filter @musecanvas/api typecheck && test` | 深链恢复；资产 owner 404；cursor 去重；mock/live 隔离 |
| Lead | `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` | 全仓无回归；M5 未混入；lockfile 与 package.json 一致 |

### 9.3 集成场景（不要求本阶段运行真实服务）

- 生图完成 → 自动恢复 Turn → 下一轮 video 以该 asset 为输入 → 完成；两个 asset ID 可追溯。
- 同一 media event 重复投递 / 乱序投递 / 部分 job 未终态：不提前结算、不重复 Item、不重复 wake。
- 工具预算冲突 / 媒体模型不可用 / owner 输入不匹配：整个工具效果回滚，Turn 得到失败结果而不是 500。
- 重启 Worker 后 lease 过期 → 新 Runner 接管；旧 fence 写入被拒绝。
- Console 刷新/SSE 断开/API 重启：snapshot + cursor 恢复，时间线与资产一致。
- mock 预览零真实请求；live 模式零 mock 写调用。

## 10. 建议执行顺序（DAG）

```text
ports.ts（本阶段完成）
  ├─ B backend：仓储 + runner 骨架
  ├─ M media：agent-media + media tools + event handler
  ├─ L language：model/context
  ├─ T tools：registry/readonly
  └─ F frontend：console + asset detail
        │
        ├─ Lead：database/index exports + worker domain dep + routes
        └─ B：最后接 Worker boot / 注入
              │
              └─ Lead：全仓验证 + M5 rebase
```

并行约束：

- `apps/worker/src/agent/ports.ts` 是只读契约；任何 lane 不得改字段。
- `apps/worker/src/agent` 文件所有权按 §5 隔离；同一时间不得两个 lane 改同一文件。
- `apps/worker/src/index.ts` 由 backend 最后一步改；lead 在 boot 集成前不接 lane 实现。
- `packages/database/src/index.ts`、`apps/api/src/router/routes.ts`、`package.json`/lockfile 由 lead 统一改。
- M5 工作区只读；不得从 `MuseCanvas-agent-m5` 复制未提交文件到本计划。
