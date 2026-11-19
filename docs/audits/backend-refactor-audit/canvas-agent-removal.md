# 旧 CanvasAgent 代码退役记录

- 日期：2026-11-18。
- 决策：用户明确要求移除旧 CanvasAgent，替代此前“先保持兼容、满足迁移门槛后再删除”的建议；旧会话不自动迁移到 Agent Core。
- 基线：`dev`，HEAD `308ccca`，包含开始时已有的 44 项工作区文件改动。执行中另有 UUID/HTTP 层并行改动，按当前内容局部编辑并保留。
- 状态：旧运行时、公开入口和前端依赖已从当前工作区移除；全仓检查结果及未验证边界见下文。未提交、推送或部署。

## 1. 移除范围

### API 和配置

移除以下 8 个旧操作，路径不再注册到 Router，也不再通过 `API_ENDPOINTS` 发布：

| 方法 | 已退役路径 |
|---|---|
| POST | `/api/canvases/:id/agent/messages` |
| GET | `/api/canvases/:id/agent/history` |
| GET | `/api/canvases/:id/agent/turns/:turnId` |
| POST | `/api/canvases/:id/agent/confirm` |
| POST | `/api/canvases/:id/agent/apply` |
| GET | `/api/canvas-agent/status` |
| GET / PATCH | `/api/admin/canvas-agent-settings` |

旧路径按现有未知路由的鉴权、Origin 和 404 规则处理：匿名请求可能先得到 401，非法 Origin 的写请求可能先得到 403，不能理解为所有请求都直接返回 404。

删除 `apps/api/src/modules/canvases/agent/` 的旧循环、工具、SSE、Store、提交及恢复实现，以及旧管理设置服务。删除 Nginx 对旧消息地址的 SSE 专用 location，保留通用 `/api/` 和图片编辑/媒体上传配置。

### Web 和 Contracts

删除旧 `useCanvasAgent`、旧 SSE/composer/timeline 辅助模块及专属测试；移除客户端旧 API、Query keys、DTO 再导出、管理设置卡片和旧错误文案。新版 `features/agent-console` 的 composer 与旧 `shared/lib/agent-composer.ts` 是不同文件，新版保留。

删除旧 `CanvasAgent*` 消息、确认、恢复、设置和流事件契约及解析器。全仓引用核对后，也删除仅服务旧助手的 `CanvasOp`/`CanvasOps`/`CanvasNodePatch`、操作解析/apply 函数、上限常量和孤立错误码；保留普通 Canvas 节点、边、场景、参数和 CRUD 请求校验。

根 OpenAPI 删除 6 个旧路径定义与 44 个旧专用 schema，保留 13 个路径及 62 个 schema；独立 Agent Core 规范未由本次重生成或覆盖。旧设置 tag 改为实际使用的 `Media model defaults`，并增加 tag 声明/使用一致性检查。

### Database 和 Worker

删除旧 `canvas-agent.ts` 与 `canvas-agent-preparations.ts` 仓储及导出。新 Agent Core 仍依赖的请求摘要算法迁至：

- `packages/database/src/canonical-json-digest.ts`：中性名称 `canonicalJsonDigest`。
- 数据库仓储直接从同一 package 内引用；Worker 经 `@musecanvas/database` 引用。
- 原算法逐字节保持对象 key 的默认词法排序、数组顺序、JSON 字符串转义和 SHA-256 输出。
- 删除旧实现前实际采集 6 组固定摘要，覆盖空值、空对象、键序、数字样式键、嵌套、Unicode、转义和数组换序；新测试固定这些摘要，保护既有幂等键、审批绑定和 checkpoint。

本次共删除 28 个旧专用受版本控制文件；删除前检查它们均不含起始工作区的未提交改动。其中混合 PG 测试的公共媒体部分迁出保留，不是整份覆盖能力一起删除。

## 2. 明确保留的边界

- 新 Agent Core 的 API、Runner、控制、恢复、审批、媒体提案及前端操作台。
- 普通 Canvas CRUD、文档仓储、节点/边/场景校验及相应 mock。
- `POST /api/images/edit/preparations`、`AgentEditPreparationDTO`、`agent_media_mask_preparations` 及 `0045_agent_media_preparations.sql`；它们属于当前 Agent Core 媒体链路。
- 共享 media-service、Provider 工具调用、图像/视频生成、Outbox、输入绑定和独立媒体 job 消费链路。
- 所有历史迁移、旧表、旧行和 `agent_legacy_links` 依赖。本次未新增删表迁移，也未运行任何数据清理。
- Worker 账户删除中的 `purgeCanvasContentForActor` 及其测试；旧代码退役不取消对历史用户内容的清理责任。

旧会话的消息读取、确认生成、场景应用和旧 turn 恢复入口随本次退役停止提供。已入队媒体 job 的公共处理实现保留，但本次未查询线上任务，也未证明旧会话或任务已排空。

既有审计 F-01 中的 legacy-link 外键阻挡历史清理，以及新 Agent 内容保留/擦除策略缺口，仍待单独处理；本次没有借退役调整数据政策或关闭数据库约束。

## 3. 测试迁移与审查修正

- Router 增加旧入口缺席、Canvas CRUD / Agent Core / 图片准备入口仍在的回归；未知旧恢复地址仍服从普通鉴权边界。
- 模块布局测试确认旧目录不存在，并核对旧 SSE Nginx 特例已移除、公共媒体 location 仍保留。
- OpenAPI 保留普通 Canvas、媒体模型默认值、图片准备 DTO、请求示例、Origin 与实际路由的校验；删除仅属于退役协议的示例和断言。
- 历史 `0031` 的 DDL 结构断言迁至 `packages/database/src/migrations/legacy-canvas-schema.test.ts`，不再依赖已删除的运行时常量。
- 原 `canvas-agent-tools-pg.test.ts` 中的公共生成、输入绑定、幂等/并发、视频、公共 multipart 图片编辑及对象回收测试迁至 `tests/integration/media-commands-pg.test.ts`，改用真实共享 `prepareGeneration`，不保留旧 Store/工具执行器。
- 媒体 PG 用例仅接受已完成当前全部迁移的专用 fixture：预检在父测试、写入及数据清理作用域之前执行，失败时关闭连接池并抛出；测试本身不执行迁移或 DDL。旧 `0033` 的真实升级/重放不在该媒体用例中冒充通过。
- 独立 Reviewer 只读审查确认未见本次退役引入的新阻断；其指出的 PG fixture、Nginx 与 OpenAPI 分类问题已据代码逐项修正。PG 预检的父/子测试失败传播边界也已修正。

## 4. 本地验证

环境：Node `v24.22.1`，pnpm `12.9.1`。本表描述本轮命令实际结果，不替代目标环境验证。

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 退出 0，全仓通过；最终测试调整后复跑通过 |
| `pnpm lint` | 退出 0，全仓无 error；仍有现有 warnings |
| `pnpm build` | 最终复跑退出 0，全仓构建通过；最终复跑耗时约 45 秒 |
| `pnpm -r --no-bail --if-present test` | 退出 1；所有包均执行，只有 Web 两项基线失败 |
| 最终 Router / Canvas OpenAPI / 模块与代理定向测试 | 29 通过、0 失败；另 1 个 PG 用例按显式 opt-in 跳过 |
| 最终媒体 PG 测试加载检查 | 正常加载、0 失败、1 跳过；没有连接数据库，不代表真实 PG 用例通过 |
| `git diff --check` | 通过 |
| 历史迁移差异检查 | `git diff --exit-code -- packages/database/migrations` 退出 0 |

全仓继续执行模式下的包测试结果：

| 包 | 通过 | 失败 |
|---|---:|---:|
| Observability | 5 | 0 |
| Contracts | 68 | 0 |
| Domain | 33 | 0 |
| Database | 316 | 0 |
| Providers | 241 | 0 |
| Media Service | 26 | 0 |
| Worker | 297 | 0 |
| API | 456 | 0 |
| Web | 163 | 2 |

Web 的两项失败均在移除前通过 `pnpm --filter @musecanvas/web test` 实际复现，最终仍为同一场景：

1. SessionSidebar 的删除、清空、置顶和行内重命名用例：断言预期 2、实际 0。
2. `attachment-references.test.mjs`：原生 Node 加载 workspace TypeScript 时无法解析 `packages/contracts/src/endpoints`，报 `ERR_MODULE_NOT_FOUND`。

本次未修改这些失败用例或通过删除/skip 来规避；因此不能将全仓测试标记为全绿。更早一次有 60 秒工具超时的运行也未作为通过证据，结果以上述完整 97 秒继续执行模式为准。

## 5. 尚未执行

- 真实 PostgreSQL/Redis、Nginx 容器、已认证旧客户端及真实 Provider/E2E 验证。
- 线上旧调用量/存量会话排空调查、旧会话数据迁移、账户数据清理或表结构退役。
- 提交、推送、构建镜像发布或远端部署。

工作区保留本次移除及用户原有和并行改动；源代码、测试与文档均可直接审阅。全仓测试的两项基线失败需另行处理，不能把本地代码退役等同于可发布状态。
