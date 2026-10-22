# MuseCanvas AI Agent Guidelines

本文档为在 MuseCanvas 项目中工作的 AI 智能体规范与协作准则。所有在本代码库中执行任务的 Agent 必须严格遵守 **Plan & Execute** 范式与 **多 Agent 协同（Multi-Agent Collaboration）** 流程。

---

## 核心原则 (Core Principles)

1. **先规划，后执行 (Plan & Execute)**：严禁在未经过结构化规划与影响分析前直接动手修改代码。任何非平凡任务必须遵循清晰的阶段演进：规划（Plan）$\to$ 多 Agent 执行（Execute）$\to$ 统一验证与收敛（Verify）。
2. **多 Agent 协同 (Multi-Agent Collaboration)**：拒绝单一 Agent 串行承担所有角色。复杂任务必须按职责拆解为不同角色的子任务，充分利用并行能力与专职分工。
3. **证据为先 (Evidence-First)**：所有关于代码、类型、接口、测试的主张必须以事实和工具运行输出为依据，严禁主观臆断。
4. **单向契约与边界隔离 (Contract-Driven Boundaries)**：遵循 Monorepo 依赖流向，契约优先（Contracts-First），跨模块修改必须保持接口兼容与类型安全。

---

## 项目架构与职责地图 (Architecture Context)

在进行任务拆解与分工时，各 Agent 须遵循项目的 Monorepo 模块职责：

```
MuseCanvas
├── apps/
│   ├── api/          # Next.js 15 (App Router) 核心后端服务 (REST API, 鉴权, 路由)
│   ├── web/     # Next.js 15 (App Router, React 19) + Zustand + TanStack Query 混合渲染前端应用（唯一前端）
│   └── worker/       # Redis Streams + 事务性 Outbox 异步任务消费端 (生成、轮询与维护任务)
├── packages/
│   ├── contracts/    # 共享 DTO (纯 TS 类型)、错误码、类型契约与 API_ENDPOINTS 端点路径常量表 (最底游依赖，无运行时校验库)
│   ├── database/     # node-postgres (pg) + 幂等 SQL 迁移、仓储层 (Repositories)、事务与种子数据
│   ├── domain/       # 业务核心领域模型、实体与纯业务规则
│   ├── providers/    # 外部依赖封装 (图像/视频生成插件、LLM 调用、凭据加密；对象存储客户端在 apps/worker、SMTP 在 apps/api)
│   └── config/       # 服务端密钥派生 (HKDF) 与 bootstrap 配置 (目前仅被 worker 以相对路径引用)
├── deploy/           # Docker Compose、Dockerfile、Nginx 配置与部署设施
└── scripts/          # 环境预热、模板预处理及维护自动化脚本
```

**依赖流向原则**：
- `contracts` 为公共基础，不依赖其他业务 package；
- `domain` 与 `database` 遵循领域驱动设计，承载业务核心；
- `providers` 封装第三方外部服务（如 LLM、图像生成 API）；
- `apps/*` 消费 `packages/*`，跨 app 间禁止直接源码相对引用，必须通过包依赖（`workspace:*`）或 API 契约解耦；
- 包管理器统一使用 `pnpm`，新增依赖时必须同步 `package.json` 与 `pnpm-lock.yaml`，禁止在子包生成独立的 `package-lock.json`。

---

## 前端架构与状态设计规范 (Frontend Standards: web)

在开发与维护 `apps/web` 时，必须严格遵循以下混合渲染与状态管理准则：

### 1. 业务驱动的混合渲染矩阵 (Hybrid Rendering Matrix)
- **公共营销与法律条款页（SSG 纯静态生成）**：
  - 路由：`/`、`/terms`、`/privacy`；
  - 规范：显式声明 `export const dynamic = 'force-static'`，严禁在这些页面或其顶层 layout 中调用 `cookies()` 或 `headers()`，确保 CDN 毫秒级缓存直出。
- **认证路由（RSC 预检 + Client Islands）**：
  - 路由：`/login`；
  - 规范：在 Server Component 中读取 `muse_session` Cookie 进行会话预检，已登录用户在服务端直接发起 307 重定向至目标页，避免客户端闪烁；表单输入与验证码为 Client Island。
- **工作区与管理后台（RSC 服务端守卫 + Client Islands）**：
  - 路由：`/(workspace)/*`、`/admin/*`；
  - 规范：利用 Layout RSC 进行统一权限门禁（未登录跳 `/login`，非管理员跳 `/`），交互控制台、图库、管理表格作为 Client Islands 挂载。

### 2. 双端隔离的 API 服务层
- **服务端 Client (`server-api.ts`)**：
  - 仅在 React Server Components (RSC) 中调用；
  - 自动提取并透传当前请求的 `muse_session` HttpOnly Cookie 到后端 API；
  - 严禁在浏览器端导入此模块。
- **客户端 Client (`client-api.ts`)**：
  - 仅在 Client Components (`'use client'`) 中调用；
  - 经由 Next.js `/api/*` 同源反向代理通信，自动携带同源 Cookie；
  - 统一拦截并格式化 API 错误响应。
- **端点路径唯一真源**：所有请求路径必须引用 `@musecanvas/contracts` 的 `API_ENDPOINTS` 常量表（动态段用其函数 helper），严禁在组件或 hook 中硬编码 `/api/...` 字面量；后端路由变更必须先同步该表。

### 3. 状态管理分工原则
- **服务端状态 $\to$ TanStack Query 托管**：
  - 用户会话、可用模型、任务列表、图库资产、积分余额与管理端数据全部由 TanStack Query 维护；
  - 数据变更后通过 `queryClient.invalidateQueries` 精确刷新，彻底消除原 Pinia 中 `generation` 与 `library` 的双向环形耦合。
- **易失性客户端 UI 状态 $\to$ Zustand 管理**：
  - 仅用于管理页面表单、草稿提示词、生成参数、图库多选与列数切换等易失性 UI 状态；
  - 保持 Store 独立、单一职责。

### 4. 设计系统与视觉规范
- 严格遵循 **Jude-Frontweb**（Soft Product 暖白柔和风格）：
  - 基础表面（Warm White / Soft Product）、高质感低饱和阴影；
  - 字体采用 IBM Plex Sans + IBM Plex Mono（代码/数值）与 Noto Sans SC；
  - 所有组件需保证良好的响应式适配与无障碍（a11y）标准。

---

## Plan & Execute 工作流规范

每次接收任务时，必须严格按照以下三阶段执行：

### 阶段一：规划阶段 (Plan)

在规划阶段，主协调 Agent（Lead/Planner）需完成以下工作：

1. **需求理解与范围界定 (Scoping)**：
   - 明确任务的明确需求（Explicit Requirements）与隐式依赖（Implicit Requirements）。
   - 确定变更影响的边界，明确哪些属于非目标（Non-Goals）。

2. **代码基调研与影响分析 (Research & Impact Analysis)**：
   - 指派只读调研类 Agent（如 `scout`）深入代码库检索相关定义、引用调用点（Callsites）、类型与数据库迁移。
   - 识别潜在的破坏性变更（Breaking Changes）、并发副作用或依赖级联更新。

3. **任务分解与有向无环图构建 (DAG Decomposition)**：
   - 将总目标解构成相互解耦、定义明确的原子级子任务。
   - 梳理子任务之间的前置依赖关系，识别可并发执行的独立切片（Independent Slices）。
   - 为每个子任务明确具体的负责 Agent 角色、交付契约与验收标准。

4. **初始化任务追踪 (Todo / Task Tracking)**：
   - 建立结构化任务列表，显式声明各任务的阶段与状态，确保执行过程全局透明。

---

### 阶段二：执行阶段 (Execute - Multi-Agent)

在执行阶段，依据规划阶段形成的 DAG，调度多个子 Agent 协同完成：

#### 1. 核心角色定义 (Agent Roles)

- **主协调 Agent (Lead / Orchestrator)**：
  - 维护全局上下文与任务看板，统一调度子 Agent。
  - 负责跨任务契约协商、共享上下文注入与执行瓶颈协调。
  - 汇总各 Agent 的产出并执行最终集成。
- **侦查/调研 Agent (Scout / Researcher - Read-Only)**：
  - 专注于模式搜索、符号查找、多文件关联分析与背景调研。
  - 快速提炼压缩上下文并回传，不修改任何文件。
- **领域实现 Agent (Domain / Backend Coder)**：
  - 负责 `packages/contracts`、`packages/database`、`packages/domain` 及 `apps/api` 的实现。
  - 遵循后端数据校验、事务隔离与错误处理规范。
- **异步处理 Agent (Worker / Provider Specialist)**：
  - 专注于 `apps/worker` 队列消费逻辑与 `packages/providers` 外部集成。
  - 处理异步重试、幂等性、超时控制与任务状态流转。
- **前端交互 Agent (Frontend Coder)**：
  - 专注于 `apps/web`（Next.js 15 + React 19 + Zustand + TanStack Query）的组件、状态、路由与页面逻辑。
  - 严格保持与 `contracts` 定义的前后端交互类型一致，遵循混合渲染与双端 API 客户端隔离规范。
- **代码审查与质检 Agent (Reviewer / QA)**：
  - 对变更实施独立审查，检查安全性、类型健壮性、边界用例覆盖与项目规范符合度。

#### 2. 多 Agent 协作准则

- **并发最大化**：凡无强依赖关系的子任务（如：更新独立的前端组件与独立的外部 Provider），必须并行派发执行，严禁无意义的串行等待。
- **契约先行 (Contracts First)**：当变更涉及跨端通信时，优先派发 Agent 完成 `packages/contracts` 或公共接口的定义并确认，然后再并发启动消费端的实现。
- **文件所有权隔离**：同一时间段内，两个并发 Agent 不得同时对同一源文件进行非协同性的破坏性编辑。若需共用文件，须明确责任边界并由主协调者合并。
- **上下文精确传递**：给子 Agent 派发任务时，提供针对性的上下文、明确的目标文件、规范和交付条件，避免派发模糊简短的一句话指令。

---

### 阶段三：统一验证与收敛 (Verify & Review)

所有子 Agent 完成各自切片后，主 Agent 负责全局质量验收：

1. **类型检查与构建验证**：
   - 运行项目标准的类型校验与构建命令（例如 `pnpm typecheck`、`pnpm build`），确保无类型错误与破坏性导出。
2. **测试验证**：
   - 运行单元测试、集成测试（`pnpm test`）及相关 E2E 测试用例，确保现有逻辑未发生回归。
3. **真实场景烟雾测试 (Smoke Testing)**：
   - 对于 UI 界面变动或 API 关键路径，结合实际运行状态或轻量调用进行行为验证。
4. **清理与交付收敛**：
   - 清理临时测试用例、未使用的调试日志或冗余代码。
   - 确认代码干净、符合项目 Lint 规范后，向用户输出完整的任务执行报告与改动明细。

---

## 任务执行检查清单 (Execution Checklist)

每个任务执行前中后，Agent 需自我检视以下事项：

- [ ] **是否已制定 Plan？** 是否已向用户明确核心思路、影响范围与步骤分解？
- [ ] **是否充分利用了 Multi-Agent？** 是否按前端/后端/Worker/审查等角色进行了合理的任务解耦与并发分发？
- [ ] **是否保持了 Monorepo 边界？** 是否有跨 Package 非法引用的情况？契约层是否保持最新？
- [ ] **是否遵循了前端混合渲染与状态管理准则？** RSC/Client 隔离是否正确？状态是否合理解耦？
- [ ] **是否完成了端到端验证？** `typecheck` 与 `test` 是否均通过？变更路径是否经过了确切证据的验证？
- [ ] **是否完成了所有跟踪项？** 初始规划中的任务清单是否均已闭环并更新状态？

---

## GitHub 分支、PR 与部署流程

1. 项目变更从 `dev` 分支进入，禁止直接向 `main` 推送。完成变更后推送 `dev` 并创建目标为 `main` 的 PR。
2. PR CI 仅对目标为 `main` 且命中 workflow 路径过滤器的变更触发。PR 中的 Docker 工作流只构建、不推送镜像；命中路径过滤器的 `main` push 会自动发布 GHCR 镜像，此外 Docker workflow 的 `workflow_dispatch` 也可在非 PR ref 上手动构建并推送。
3. 若需在合并前部署 `dev` 验证，必须对 `.github/workflows/docker-image.yml` 在 `dev` ref 手动运行 `workflow_dispatch`。当前 workflow 生成 `dev` 和 `sha-<7 位短 commit SHA>` tag（例如 `sha-003465a`），不使用完整 commit SHA 作为 tag；记录镜像 digest 才能严格固定镜像。`latest` 仅由默认分支构建更新，`dev` tag 是可变 tag。
4. 镜像发布与远端部署是独立步骤。本仓库没有自动 SSH/部署工作流；除非另有已验证的自动化配置，部署由操作人员在部署机使用 `deploy/compose.images.yaml` 执行 `pull` 和 `up -d`，并明确设置 `MUSECANVAS_IMAGE_TAG`。部署机的 `.env` 必须预先提供 `POSTGRES_PASSWORD` 和 `APP_MASTER_KEY` 等 Compose 要求的配置；不得读取或输出密钥值。
5. 部署后必须进行健康检查和目标场景烟雾测试；CI、镜像构建通过不等于已部署或验证。所有验证通过后才合并 PR；失败时停止合并，记录故障并按部署机既定回滚流程恢复。
6. 不得把 SSH 密钥、访问令牌、`.env` 或其他部署凭据写入仓库、PR 或日志。部署主机、目录、测试地址和回滚方式只能依据已核实的信息，不得猜测。
