# 画布（Canvas）功能废弃通知

> **状态**：已决策废弃（2026-11-18）；**后端代码已于同日彻底删除**
> **受影响范围**：前端 `apps/web` 禁止新增（触点待 Kimi 前端重构收敛后移除）；后端 `apps/api`、`apps/worker`、`packages/database` 画布逻辑已全部删除；`packages/contracts` 仅保留类型 shim
> **通知对象**：所有参与本仓库开发的 AI Agent 与协作者。**当前正在进行的并行前端修改工作（如 Kimi）请务必阅读本文档后再动手。**

---

## 1. 决策结论

画布（Canvas）功能已决策废弃，并已完成后端代码的彻底删除：

- **后端已删除（2026-11-18）**：`apps/api` 画布模块/路由/openapi、`apps/worker` 的 `get_canvas@v1` 工具与相关上下文、`packages/database` 的 `canvas-documents` 仓储与创建路径画布校验，详见第 5 节清单。
- **前端立即停止新增**：不为画布新增功能、组件、hooks、API 封装；现有触点将在前端重构收敛后统一移除。
- **契约层过渡 shim**：`contracts` 的 `canvas.ts`、`API_ENDPOINTS.canvases`、`defaultCanvasId` 因 web 前端仍在导入而暂时保留并标 `@deprecated`；前端触点移除后一并删除。

### 背景说明

画布最初的设计定位是「创作中枢」（DB 迁移命名 `canvas_agent_*` 可证）。但现状是：

- 可视化画布编辑器已在 UI 重构中移除，前端仅剩一个管理对话框（创建时只能填标题）；
- Agent 对画布只有只读工具（`get_canvas@v1`），生成结果不会写回画布；
- 用户无法通过任何界面有效编辑画布场景。

因此画布当前既无用户价值，也不构成 Agent 链路的必要环节，决策废弃。

---

## 2. 对前端开发的执行规则（重要）

正在修改 `apps/web` 的 Agent / 协作者请遵守：

1. **禁止新增画布相关代码**：不得新增画布功能、组件、hooks、API 调用；新代码不得导入本文档第 3 节列出的任何符号。
2. **后端画布 API 已删除**：`/api/canvases` 全部端点返回 401/404，前端画布管理对话框已无可用后端；请勿调用，尽快在触手可及时解耦。
3. **触碰相关文件时的处理原则**：
   - 做与画布无关的修改时，正常进行，无需顺手清理画布代码；
   - 若改动自然涉及画布（例如重构 Agent 控制台布局、调整会话创建参数），可将画布入口与引用一并摘除，但**不要为此单独发起大范围删除**。
4. **会话关联字段**：会话创建的 `defaultCanvasId` 后端仍接受但**忽略**（不校验、不存储，DTO 恒为 `null`）；前端应停止发送。

---

## 3. 前端画布触点清单（2026-11-18 快照）

> 行号为快照参考，会随编辑漂移；以**符号名**为准进行检索（`rg "canvas" -i apps/web/src`，注意排除第 4 节的 CSS 令牌误报）。

### 功能组件（agent-console）

| 文件 | 内容 |
| --- | --- |
| `apps/web/src/features/agent-console/components/canvas-manager-dialog.tsx` | 画布管理对话框（唯一画布 UI 入口：列表/创建/重命名/删除/节点构成展示） |
| `apps/web/src/features/agent-console/lib/canvas-form.ts` 及 `canvas-form.test.mjs` | 画布表单草稿、场景序列化（`buildCanvasCreateRequest` / `buildCanvasUpdateRequest` / `canvasDraftFrom` 等） |
| `apps/web/src/features/agent-console/components/agent-console-view.tsx` | 引用点：`CanvasManagerDialog` 导入与挂载、`canvasManagerOpen` 状态、「管理画布」按钮、`defaultCanvasId` 会话关联及「已关联所选画布」文案 |

### 服务层（shared/services）

| 文件 | 内容 |
| --- | --- |
| `apps/web/src/shared/services/client-api.ts` | `canvasesApi`（list/create/detail/update/remove），并挂载为 `api.canvases`；`Canvas*` DTO 类型导入；`mockCanvasesApi` 分支 |
| `apps/web/src/shared/services/server-api.ts` | `getCanvases` / `getCanvas` 函数及类型导入 |
| `apps/web/src/shared/services/mock-agent-api.ts` | `mockCanvasesApi` 完整 mock 实现与 `Canvas*` DTO 导入（该文件 canvas 引用最多，约 50+ 处） |

### 状态与类型（shared）

| 文件 | 内容 |
| --- | --- |
| `apps/web/src/shared/hooks/query-keys.ts` | `queryKeys.canvases.*`（root / list / detail） |
| `apps/web/src/shared/hooks/useAgentConsole.ts` | 会话创建入参 `defaultCanvasId`、会话详情返回后的画布 detail query 失效逻辑 |
| `apps/web/src/shared/types/index.ts` | `CanvasDto` / `CanvasScene` / `CanvasNode` / `CreateCanvasRequest` / `UpdateCanvasRequest` / `CANVAS_DEFAULT_TITLE` / `CanvasErrorCode` 等再导出 |
| `tests/e2e/ui-redesign.mjs` | e2e 脚本内 mock 服务器的 `/api/canvases` 假端点与 `?canvas=` 路由参数（自包含 mock，不依赖真实后端，随前端清理一并移除） |

---

## 4. 不要误伤（清理时的排除项）

以下内容名称含 canvas 但与画布功能**无关**，清理时必须保留：

- **CSS 设计令牌**：`bg-canvas`、`from-canvas`、`via-canvas` 等 Tailwind 主题色 token（暖白底色），遍布控制台布局代码，与画布功能无关；
- **后端契约**：`packages/contracts` 的 `API_ENDPOINTS.canvases`、`canvas.ts` 契约与校验逻辑（后端冻结保留，前端停止使用即可）；
- **数据库迁移**：`packages/database/migrations/0030~0033_canvas_*.sql`，已应用的迁移不可删除或改写。

---

## 5. 后续计划

### 已完成（2026-11-18，后端彻底删除）

| 层 | 删除内容 |
| --- | --- |
| `apps/api` | `modules/canvases/` 整个模块、router 中 5 条 canvas 路由与导入、`canvas-openapi.test.ts`、`openapi.yml` 全部 canvas paths/schemas/tags |
| `apps/worker` | `get_canvas@v1` 工具及 readonly/registry/ports 中的画布分支、`ToolContext.canvasId`、`canvas_mutation` 执行类型、`AgentReadOnlyToolPorts` 死接口、`scripts/agent-definition.ts` 默认 allowlist 中的画布工具 |
| `packages/database` | `repositories/canvas-documents*`、索引导出、`agent-core.createSession` 的 canvas_documents 外键校验与 `default_canvas_id` 写入（列保留、可空） |
| 测试 | `router.test.ts`/`readonly.test.ts`/`registry.test.ts`/`context.test.ts`/`media.test.ts`/`agent-composition.test.ts`/`agent-core.test.ts` 中画布用例改写或删除；`tests/integration/canvas-http-boundary.test.ts` 删除 |

### 待办

1. **前端统一移除**（待 Kimi 前端重构收敛后执行）：按第 3 节清单删除全部前端触点 → `pnpm typecheck` + `pnpm test` 验证 → 全局 `rg` 复查，随后删除 contracts 的 canvas shim（`canvas.ts`、`API_ENDPOINTS.canvases`、`defaultCanvasId`）。
2. **数据库表下线决策（待确认，不可逆）**：`canvas_documents`、`canvas_agent_*` 遗留表与 `agent_sessions.default_canvas_id` 列仍在已部署库中。确认后需新增 drop 迁移；在此之前以下遗留清理逻辑暂时保留：
   - `apps/worker/src/maintenance/canvas-cleanup.ts`（账号删除时清除画布遗留数据，被 `claimed-cleanup.ts` 调用）；
   - `apps/worker/src/maintenance/account-readiness.ts` 中对 `canvas_agent_turns/canvas_agent_sessions/canvas_agent_pending_jobs` 的保护性 EXISTS 检查；
   - `packages/database/src/migrations/legacy-canvas-schema.test.ts`（历史迁移可重放性保证）。
