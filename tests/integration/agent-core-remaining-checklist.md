# Agent Core 剩余非 M5 集成验证清单

基线：`feat/agent-core-fixtures` @ `f55e9d4`（M1–M4 快照）
角色边界：本切片只新增测试与本文档；不修改实现、共享 fixture、旧迁移或策略开关。M5 的 controls / gray / coordinator 由用户负责，不在本清单的待办范围内。

## 0. 本次落地的可审计内容

| 文件 | 性质 | 证明范围 |
|---|---|---|
| `tests/integration/agent-media-terminal-pg.test.ts` | 新增 opt-in PostgreSQL fixture | 仅用 0041–0043 既有 schema 的裸 SQL，验证 dedupe、复合 owner/link、media 终态 Outbox 与 Turn 终态批处理的原子回滚 |
| `tests/integration/agent-streams-redis.test.ts` | 新增 opt-in Redis Streams fixture | 验证既有 outbox 路由常量/字段、Agent 与 media/generation stream 隔离、独立 consumer group、重复 event ID 与未 ACK 重投语义 |
| 本文档 | 验证清单 | 明确已证明、未证明和必须等 Runner/media consumer/API 落地后执行的运行期用例 |

两个 fixture 都只在显式专用 URL 存在时运行，默认 `SKIP`：

- `MUSECANVAS_AGENT_MEDIA_TERMINAL_PG_URL`：必须为 `postgresql://fixture@127.0.0.1:<port>/postgres`；fixture 自动创建并删除 `agent_media_terminal_<uuid32>` 数据库。
- `MUSECANVAS_AGENT_STREAMS_REDIS_URL`：必须为 `redis://127.0.0.1:<port>/15`；只写入 `fixture:agent-streams:<uuid>` 命名空间并在 `finally` 删除自己的 key。

约束：不读取 `.env`，不回退到 `DATABASE_URL` / `REDIS_URL`，不启动 API/Worker/DB/Redis/Provider，不连接远程环境，不 stage/commit/push。PG fixture 使用 `CREATE DATABASE` 和 `DROP DATABASE ... WITH (FORCE)` 只操作本次生成的库名；Redis fixture 不 `FLUSHDB`、不触碰生产 stream key。

## 1. PostgreSQL 故障矩阵（已落地断言）

测试文件：`tests/integration/agent-media-terminal-pg.test.ts`

> 重要限制：文件中的“消费批次”是裸 SQL helper，按设计 §18.5 的预期步骤模拟。它证明 schema 约束与事务边界，**不证明**未来的 `media.job.completed` producer、Agent media event consumer 或 Runner 已实现且行为正确。

| ID | 场景 | 设置的故障/批次 | 必须成立的不变量 |
|---|---|---|---|
| PG-MEDIA-01 | 多个 `ToolJobLink` 未全部终态 | 同一 tool 链接两个 job；先消费一个事件，两个 job 仍 `running` | `agent_consumed_events` 可有本次标记，但 tool 保持 `waiting_external`；无 item/event/wake；Turn 保持 `waiting_tools` |
| PG-MEDIA-02 | 所有依赖终态才完成 | 两个 job 分别 `succeeded` / `failed` 后消费最后一个事件 | 只生成 1 个 `tool_result` item（含 displayable `content`）、1 条 `tool.updated` event、1 个 `agent.turn.wake`；Turn `queued`、revision +1；event 带 `entity_revision`，tool payload 为完整 `{tool:{id,turnId,toolName,status,revision}}`；经真实 `AgentCoreRepository` 读回 DTO 不变形 |
| PG-MEDIA-03 | 重复 event 且 consumer 名稳定 | 同一 `(consumer_name,event_id)` 再消费 | 第二次为 no-op；item/event/wake/cursor/revision 全部不变 |
| PG-MEDIA-04 | consumer 名不稳定 | 换一个 consumer 名重放同一 event | 新增一条 consumed 标记，但终态 tool 检查阻止第二个 result/item/wake；生产必须使用部署稳定 consumer 名 |
| PG-MEDIA-05 | 批次中途失败 | 在一个事务内完成 dedupe、tool result、Turn transition、event、wake 后执行 `SELECT 1/0` | 全部回滚：无 consumed 标记、无 item/event/wake、tool/Turn/cursor 与执行前完全一致 |
| PG-MEDIA-06 | 回滚后重放 | 用同一 event 重新提交干净事务 | 恰好成功一次；随后重复 event 仍为 no-op |
| PG-OWNER-01 | 跨 owner job link | owner A 的 tool/session/turn 链接 owner B 的 `generation_jobs` | 复合 FK `(media_job_id, owner_id)` 拒绝，SQLSTATE `23503` |
| PG-OWNER-02 | 跨 owner session/turn | owner A 的 tool 搭配 owner B 的 session/turn | 复合 tool/session/turn FK 拒绝，`23503` |
| PG-OWNER-03 | owner 参数错配 | owner B 的 tool/session/turn 使用 owner A 的 owner_id/job | `(session_id, owner_id)` FK 拒绝，`23503` |
| PG-LINK-01 | 同一条语句部分合法 | 多行 INSERT 中一行合法、一行跨 owner | 整条语句回滚，合法行也不落库 |
| PG-LINK-02 | 重复 link | 相同 `(tool_call_id, media_job_id)` 再插入 | PK 冲突；`ON CONFLICT ... DO NOTHING` 不新增行 |
| PG-LINK-03 | 重复 position | 同一 tool 的新 job 复用 position `0` | `UNIQUE(tool_call_id, position)` 拒绝，`23505` |
| PG-OWNER-04 | owner-scoped link 读取 | 用 owner B 过滤 owner A 的 link | 查询返回 0 行；link 行保存的 `owner_id` 始终为 A |
| PG-OUTBOX-01 | media job 终态与 Outbox 同事务 | 更新 job 为 `failed` 并插入 `media.job.completed`，随后 `SELECT 1/0` | job 仍为 `running`，`completed_at/error_code` 为 NULL，Outbox 0 行 |
| PG-OUTBOX-02 | 提交终态批次 | 同一事务成功提交 | job `failed` 与 1 条 `media.job.completed` 同时可见；payload 为 `{schemaVersion:1,jobId}` |
| PG-OUTBOX-03 | 相同 dedupe key | 用相同 `dedupe_key` 再插入 | 仍只有 1 行；dedupe 由部分唯一索引保证 |
| PG-TERMINAL-01 | Turn 终态与 active 指针清理 | 插入 terminal event、Turn→`failed`、`active_turn_id=NULL` 后 `SELECT 1/0` | 三处全部回滚；Turn 仍 `waiting_tools`，active 指针仍指向该 Turn |
| PG-TERMINAL-02 | 提交终态批次 | 同一事务成功提交 | Turn `failed`、`terminal_at` 非空、active 指针为空、event cursor +1；`turn.updated` 带 `entity_revision` 且 payload 为完整 `{turn:{id,sessionId,status,revision,inputRevision,deadlineAt,engineVersion,...}}`；经真实 `AgentCoreRepository` 读回 DTO 不变形 |
| PG-TERMINAL-03 | 终态重开 | 尝试把已终态 Turn 改回 `queued` | 触发器拒绝，匹配 `cannot reopen` |

### 1.1 本 fixture 不能证明的内容

- 不能证明 `generation_jobs` 的所有终态写点都会发 `media.job.completed`，也不能证明只在真实状态变化时发一次。
- 不能证明 dedupe key 已包含 `jobId + retry cycle/attempt identity + terminal revision`；fixture 只验证 `outbox_events.dedupe_key` 的部分唯一索引可用。
- 不能证明 Agent media consumer 在数据库 commit 后才 `XACK`，也不能证明 rollback 时不会 ACK。
- 不能证明真实 Runner 的锁顺序、lease/fencing、取消竞态、迟到资产策略或预算结算。

## 2. Redis Streams 契约矩阵（已落地断言）

测试文件：`tests/integration/agent-streams-redis.test.ts`

| ID | 场景 | 必须成立的不变量 |
|---|---|---|
| REDIS-01 | wake 路由 | `agent.turn.wake` 路由到 `AGENT_STREAM`；字段精确为 `eventId/aggregateId/schemaVersion/sessionId/turnId/revision`；`revision` 必须是非零十进制字符串 |
| REDIS-02 | media fact 路由 | `media.job.completed` 路由到 `AGENT_MEDIA_EVENT_STREAM`；字段为 `eventId/aggregateId/schemaVersion/jobId`；不接受 `schemaVersion != 1` 或空 jobId |
| REDIS-03 | stream 隔离 | Agent、media、generation 三个 stream 常量互不相等；两个 Agent 路由都不落到 `GENERATION_STREAM` |
| REDIS-04 | 重复 event ID | 同一 wake 字段 `XADD` 两次得到两个 entry、同一 `eventId`；Redis 不去重，必须依赖 `agent_consumed_events` |
| REDIS-05 | 独立 consumer group | 两个 fixture-local group 都从 `0` 读取到全部 entry；一个 group `XACK` 不影响另一个 group 的 pending |
| REDIS-06 | 崩溃重投 | 未 ACK entry 可被新 consumer `XCLAIM` 成功；重投不改写 stream 内容，也不 ACK 其他 group |
| REDIS-07 | 队列隔离 | media fact 只出现在自己的 key；Agent wake 不污染 media key，也不写入 generation stream |
| REDIS-08 | 清理边界 | 只删除 `fixture:agent-streams:<uuid>` 下自己创建的两个 key；不 `FLUSHDB`、不删除生产 key |

### 2.1 未证明内容

- fixture 使用合成的 `fixture:agent-streams:<uuid>` key 和 fixture-local group 名；这不是生产 `muse:agent` / `muse:agent-media-events` 的 group 拓扑，也未证明真实 Agent 与 media consumer 使用不同 group。
- 未接入真实 Agent consumer，因此不能证明它使用稳定的独立 group 名、正确的 `XREADGROUP`/`XAUTOCLAIM` 参数、心跳或并发上限。
- 未启动 Outbox dispatcher；路由字段正确不等于 producer 已按该字段写入、dispatch lease/隔离/重试正确。
- 未验证真实 Worker 重启后 pending 的 `idle` 阈值与 heartbeat key 过期时间配合。

## 3. 设计 §13.1 必测场景处置

| §13.1 场景 | 当前状态 | 说明 |
|---|---|---|
| 同一 Session 同时创建两个 Turn | 已有 schema/repo 单测；运行期待补 | 部分唯一索引与仓储单测存在；HTTP/Runner 并发 admission 未在本切片执行 |
| 同一 idempotency key 重复提交 / 不同 body 冲突 | 已有 repository + reliability PG；运行期待补 | 新 fixture 不重复该断言；API 路由与真实事务待运行 |
| Worker 提交 ToolCall 后进程崩溃 | **未覆盖** | 见 RUN-01；需要 Runner 与真实崩溃/重启 fixture |
| lease 到期前后两个 Runner 竞争 | SQL 已有 `agent-runtime-pg`；运行期待补 | SQL lease/fencing 已覆盖；真实 Runner 竞争见 RUN-03 |
| 旧 fencing token 写状态 | SQL 已有 `agent-runtime-pg`；运行期待补 | 同上，需通过真实 Runner 触发 |
| API 重启、Worker 重启、Redis 重投 | Redis 契约已覆盖；运行期待补 | 见 RUN-02；未启动进程 |
| Item sequence 并发分配无重复 | repo 单测；运行期待补 | 见 RUN-06 |
| image → video 依赖链 | **未覆盖** | 见 MED-09；需要真实 asset readiness、owner 校验与 media producer/consumer |
| 多个 ToolJobLink 全完成后才唤醒 Turn | **裸 SQL 已模拟** | PG-MEDIA-01/02；真实 consumer 见 MED-08 |
| 重复/乱序/过期 media event | **部分裸 SQL** | PG-MEDIA-03/05/06；乱序/过期真实事件见 MED-03 |
| Provider accepted 后 API/Worker 崩溃 | **未覆盖** | 见 MED-04；需要 Worker/provider fixture |
| submission unknown 不重复计费 | 现有 job 单测部分覆盖 | 新 Agent 预算/媒体链见 MED-04 |
| asset 保存失败后的 ingestion 恢复 | **未覆盖** | 见 MED-05 |
| cancel 与完成事件竞态 | **未覆盖** | 见 MED-06 |
| Provider 不支持 cancel 的真实语义 | provider 单测有部分覆盖 | 新 Agent 链见 MED-07 |
| 跨 owner Session/Asset/Job/Canvas 访问 | repo + 新 PG link 已覆盖部分 | API/SSE/asset/job 入口仍见 INT-01 |
| tool schema 注入、额外字段、超深 JSON、超大输出 | 现有工具校验单测 | 新 Runner registry/executor 见 INT-04 |
| 模型返回未注册工具 | **未覆盖** | 见 INT-05 |
| 模型仅文本能力时不声称视觉评价 | **未覆盖** | 见 INT-06 |
| Canvas revision conflict / 重复 apply | 旧 Canvas 测试部分覆盖 | 新 Core adapter 见 INT-07 |
| Approval hash 变化 / 重复确认 | reliability PG 已覆盖 SQL | HTTP/API 与真实 Runner 见 INT-03 |

M5 专属项（feature flag admission、灰度、`pause_new_tools`、coordinator 扫描过期队列/悬挂状态、回滚窗口）不在本清单待办内，由用户负责。

## 4. 待运行期用例（缺 API/进程，未写空测试）

下列用例需要尚未落地的 Runner、media producer/consumer、API 或 Worker 进程。当前不写引用未落地命名导出的测试，避免“假成功”覆盖。每项给出最小 setup 与必须断言；落地后应放在独立 opt-in fixture。

### 4.1 Runner / 崩溃恢复

| ID | 最小 setup | 必须断言 | 依赖 |
|---|---|---|---|
| RUN-01 | Turn `running` 且已有 lease；记录 model round 与一个已 commit 的 ToolCall；在提交模型响应前中止进程 | 恢复后同一 Turn 复用原 ToolCall identity；不重复提交付费媒体；模型调用重试计数增加；旧未提交工具标为 `skipped/superseded` 并补 result | Runner 执行器、真实 Worker 启停 fixture |
| RUN-02 | 同一 wake event 投递两次；第一次数据库 commit 前模拟异常，第二次重投 | 第一次不 ACK；第二次 commit 后 ACK；item/event/wake 各一次；稳定 consumer 名下 `agent_consumed_events` 一行 | Agent wake consumer、真实 Redis + PG |
| RUN-03 | Runner A 持 lease，Runner B 等过期后 claim；A 继续尝试写 tool result/Turn | B 拿到下一 fencing token；A 的写入全部 `LEASE_REJECTED`；A 不产生 item/event/wake/费用结算 | 真实 Runner 并发与 DB 时钟 |
| RUN-04 | 同一 Session 两个并发消息请求 | 只有一个非终态 Turn；第二个请求得到明确 conflict 或 steering 语义；不重复 wake | API service + Runner |
| RUN-05 | 同 key 同 body 重放；同 key 不同 body；进程在写 receipt 后崩溃 | 同 body 返回同一 Turn/receipt；不同 body conflict；崩溃重放不重复 Item/Turn/wake | API admission、`agent_*_receipts` |
| RUN-06 | 两个 Runner/事务并发追加 Item | `agent_items.sequence` 在 Session 行锁下唯一递增；无跳号覆盖；event itemSequence 对应正确 | Runner item append |
| RUN-07 | 模型请求发出后写入 steering（input revision +1） | 旧响应只作审计；未提交工具 superseded 且有错误 result；不使用过期参数提交媒体；重新规划 | Runner context/round |
| RUN-08 | 一个 round 含成功、失败、approval rejection、cancel 多个工具 | 所有 ToolCall result 齐备前不开始下一轮模型；最终 tool result 只追加一次 | Runner tool executor |
| RUN-09 | Turn deadline 在模型/媒体等待中到期 | 停止新工具、按策略终态或保留可恢复状态；旧 token 不写效果；不伪造完成 | Runner deadline/lease |

### 4.2 媒体终态与 Outbox producer/consumer

| ID | 最小 setup | 必须断言 | 依赖 |
|---|---|---|---|
| MED-01 | 真实 job 走到 success / final failure / pre-run failure / local queued cancel / worker cancellation | 每个真正终态写点在同一事务写 1 条 `media.job.completed`；`retry_wait` 不写；无状态变化不写 | job terminal helper（设计 §18.5） |
| MED-02 | job attempt/retry cycle 变化后旧终态事件重投 | dedupe key 包含稳定 execution cycle + terminal revision；旧事件不能结算新 attempt；新 cycle 可产生新 fact | job retry 模型 + producer |
| MED-03 | 重复、乱序、过期 event；consumer 在 DB commit 前崩溃 | 权威状态读 job/assets；重复不重复结算；过期事件不覆盖新 cycle；DB commit 后才 ACK | media event consumer |
| MED-04 | Provider accepted 后 Worker 崩溃，随后恢复 | 不重复提交、不重复计费；submission unknown 标 unknown 并走协调，不伪造 succeeded | Worker/provider run |
| MED-05 | job 成功但 asset ingestion/输出保存失败 | 资产恢复路径可重试；不伪造 ToolCall completed；最终 result 只一次 | ingestion + ToolJobLink |
| MED-06 | cancel 与完成事件并发；取消后 Provider 仍产出迟到资产 | Turn 保持 cancelled；迟到资产按显式策略保存并标 `late_after_turn_cancel`；不复活 Turn、不重复计费 | media consumer + worker |
| MED-07 | Provider 明确不支持 cancel；请求 cancel | 记录真实 Provider 终态/能力；不把“未取消”伪装为取消成功；费用与结果按真实状态记录 | provider adapter |
| MED-08 | 真实 media event 驱动所有 link 完成后唤醒 | 只有全部 link 终态才 Turn `queued` + wake；重复/并发事件不产生第二个 tool result/wake | Agent media consumer |
| MED-09 | tool A 生成 asset；tool B 的输入引用该 asset。分别在 asset 未 ready、owner 不匹配、ready 且 owner 匹配时请求提交 B | 未 ready 或 owner 不匹配时 B 不得提交，也不得跨 owner 复用 asset；只有 asset ready 且 owner 与 Session 一致后才允许 B 提交；失败不伪造 B 的结果 | asset readiness/owner-scoped lookup + tool executor + media-service |

### 4.3 接口、SSE 与工具安全

| ID | 最小 setup | 必须断言 | 依赖 |
|---|---|---|---|
| INT-01 | owner A 的 session/turn/item/event/approval/asset/job 被 owner B 通过 API/SSE 访问 | 全部 404/403，不泄露存在性；owner-scoped 查询不返回 A 的数据 | Agent routes/SSE |
| INT-02 | SSE 断开后带 `Last-Event-ID` 重连；删除保留期事件 | 先发 ready/snapshot，再补 cursor 之后事件；eventId 去重；gap/retention 触发 `resync.required`；不因断流取消 Turn | API events/SSE |
| INT-03 | Approval 参数 hash 变化、重复确认、过期确认；lease/crash 后确认 | hash 不匹配拒绝；重复确认幂等；过期拒绝返回 expired；确认不直接提交媒体，由 Runner 恢复提交 | API + Runner |
| INT-04 | 工具 schema 注入、额外字段、超深 JSON、超大输出 | 严格 schema 校验；拒绝额外字段/超限；错误可回传且不落敏感内容 | tool registry/executor |
| INT-05 | 模型返回未注册工具或 allowlist 外工具 | 不执行；记录可审计错误结果；不进入下一轮上下文作为成功 | Runner tool registry |
| INT-06 | 文本-only 模型被要求视觉评价 | 不声称已看/评价图片；按 capability 返回不可用或请求视觉模型 | model capability policy |
| INT-07 | Canvas revision conflict、重复 apply、旧 revision 操作 | 冲突显式返回；同一 apply 幂等；旧 revision 不覆盖新状态 | Core canvas adapter |

## 5. 运行协议（未来获授权后）

```bash
# PostgreSQL：显式专用 URL，fixture 自建临时库并自删
MUSECANVAS_AGENT_MEDIA_TERMINAL_PG_URL='postgresql://fixture@127.0.0.1:<port>/postgres' \
  apps/worker/node_modules/.bin/tsx --test tests/integration/agent-media-terminal-pg.test.ts

# Redis：只允许 loopback /15；唯一 key 命名空间，finally 删除自己的 key
MUSECANVAS_AGENT_STREAMS_REDIS_URL='redis://127.0.0.1:<port>/15' \
  apps/worker/node_modules/.bin/tsx --test tests/integration/agent-streams-redis.test.ts
```

执行前必须确认：

1. 目标为同机 loopback fixture role（PG 用户名 `fixture`；Redis `127.0.0.1` `/15`）。
2. 不 source `.env`，不设置或继承 `DATABASE_URL` / `REDIS_URL`。
3. 不在生产库/Redis 上执行；PG 只 `CREATE/DROP` 本次随机库名，Redis 只 `DEL` 本次随机 key。
4. 失败时保留输出日志但不得输出凭据；PG `DROP DATABASE ... WITH (FORCE)` 仅在本次创建成功时执行。

## 6. 本切片实际执行的静态/非运行验证

- `pnpm exec tsc --noEmit -p <temporary-tsconfig>`：**exit 0**。临时 tsconfig 未提交，仅用于把根目录 `tests/integration` 的 `pg`/`redis` 类型解析到 workspace 包；开启 `strict`、`noUnusedLocals`、`noUnusedParameters`、`noImplicitReturns`、`noFallthroughCasesInSwitch`。
- 两个 fixture 是 **manual-only opt-in**：`.github/workflows/media-quality.yml` 的 `tests/integration/*.test.ts` glob 会加载文件，但没有专用 URL 时只 skip；`backend-reliability.yml` 只跑 `backend-reliability*`。因此 CI 里的 skip 不是行为验证，也不是本清单的完成门禁。
- `runMigrations` 会在其迁移连接上执行 `SET statement_timeout=0`；该连接回到 pool 后，后续测试语句在该连接上可能绕过 pool 级 `statement_timeout`，本 fixture 未额外补偿。
- 两个新 fixture 在 `MUSECANVAS_AGENT_MEDIA_TERMINAL_PG_URL` / `MUSECANVAS_AGENT_STREAMS_REDIS_URL` 未设置时运行：**2 skipped，0 failed**。
- `apps/worker/node_modules/.bin/tsx --test apps/worker/src/queue/outbox-routing.test.ts packages/database/src/migrations/agent-core.test.ts packages/database/src/repositories/agent-core.test.ts packages/database/src/repositories/agent-runtime.test.ts`：**61 passed**。
- `pnpm --filter @musecanvas/worker test`：**116 passed**。
- `pnpm --filter @musecanvas/database test`：**191 passed**。

未执行：任何真实 PostgreSQL/Redis 连接、迁移、API/Worker 启动、Provider 调用、容器、部署、stage/commit/push。

## 7. 结论与风险

- 本切片能提供：schema 级 dedupe/owner/link/terminal/Outbox 事务证据，以及 stream 路由/独立 group/重投契约证据；可作为合并后首批集成失败点。
- 本切片不能提供：新 producer/consumer 已正确接入、真实进程崩溃恢复、真实 Provider 语义、HTTP/SSE 端到端、M5 灰度/协调器行为。
- 最大残余风险：真实 consumer 若使用不稳定 consumer 名、在数据库 commit 前 ACK、或在 Outbox 失败后仍推进状态，现有裸 SQL 和 Redis 契约测试无法阻止；必须执行第 4 节运行期用例后才可宣称闭环。
