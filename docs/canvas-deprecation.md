# 画布（Canvas）功能废弃通知

> **状态**：已决策废弃（2026-11-18）
> **受影响范围**：前端 `apps/web` 立即生效；后端（`packages/contracts`、`apps/api`、`apps/worker`）暂时保留冻结
> **通知对象**：所有参与本仓库开发的 AI Agent 与协作者。**当前正在进行的并行前端修改工作（如 Kimi）请务必阅读本文档后再动手。**

---

## 1. 决策结论

画布（Canvas）功能已决策废弃：

- **不再投入任何开发**：不为画布新增功能、组件、hooks、API 封装或可视化编辑器。
- **前端先行解耦**：前端停止使用画布；现有触点将在前端重构收敛后统一移除。
- **后端暂不删除**：`/api/canvases` 端点、contracts 中的 canvas 契约、DB 迁移（0030~0033）、worker 的 `get_canvas@v1` 只读工具均保留冻结，后续另行决策是否下线。

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
2. **不要求立即全量删除**：统一移除将在前端重构收敛后执行，避免与并行工作产生冲突。当前阶段以「不扩散」为目标。
3. **触碰相关文件时的处理原则**：
   - 做与画布无关的修改时，正常进行，无需顺手清理画布代码；
   - 若改动自然涉及画布（例如重构 Agent 控制台布局、调整会话创建参数），可将画布入口与引用一并摘除，但**不要为此单独发起大范围删除**。
4. **会话关联字段**：会话创建的 `defaultCanvasId` 为可选字段，后端仍接受。前端 UI 可以不再提供画布选择入口；已有透传逻辑保留或移除均可，不做硬性要求。
5. **移除代码时的验证要求**：任何删除性改动完成后必须运行 `pnpm typecheck` 与相关测试，确认无残留引用（详见第 3 节清单）。

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

---

## 4. 不要误伤（清理时的排除项）

以下内容名称含 canvas 但与画布功能**无关**，清理时必须保留：

- **CSS 设计令牌**：`bg-canvas`、`from-canvas`、`via-canvas` 等 Tailwind 主题色 token（暖白底色），遍布控制台布局代码，与画布功能无关；
- **后端契约**：`packages/contracts` 的 `API_ENDPOINTS.canvases`、`canvas.ts` 契约与校验逻辑（后端冻结保留，前端停止使用即可）；
- **数据库迁移**：`packages/database/migrations/0030~0033_canvas_*.sql`，已应用的迁移不可删除或改写。

---

## 5. 后续计划

1. **前端统一移除**（待前端重构收敛后执行）：按第 3 节清单删除全部前端触点 → `pnpm typecheck` + `pnpm test` 验证无残留引用 → 全局 `rg` 复查。
2. **后端冻结待决策**：画布 API、契约、worker `get_canvas@v1` 工具、DB 表保留；待 Agent 链路运行时验证（admission 开关、`agentPreparation` 调用方等阻断项确认）后，再决定后端画布是彻底下线还是以「轻量上下文存储」形态保留。
