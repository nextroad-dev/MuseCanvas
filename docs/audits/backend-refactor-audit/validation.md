# 验证记录

## 推荐实施后的最新结果（2026-11-18）

本节对应旧 CanvasAgent 代码退役及 R-01–R-07 实施后的工作区，取代下面原审计快照中的“最终”结果；各阶段计数不混用。实施和审查细节见 `implementation.md`，退役阶段见 `canvas-agent-removal.md`。

| 检查 | 最新结果 |
|---|---|
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 均 exit 0；lint/build 仍有既有非阻断 warnings |
| `pnpm -r --no-bail --if-present test` | 1,652 pass / 0 fail / 0 skip，exit 0；包含 Web 185、Worker 310、API 463 |
| `pnpm test:tooling` | 额外 17 pass / 0 fail / 0 skip，exit 0；含真实 Node TAP 协议无服务子进程检查 |
| `pnpm check:docker-manifests` | API/Web/Worker 的安装输入、最终 WORKDIR 结构校验通过，不等于实际构建 |
| `pnpm install --lockfile-only --offline --frozen-lockfile` | exit 0 |
| `git diff --check` | exit 0 |
| 五套 Agent PG/Redis fixture 的无服务加载 | 0 pass / 5 skip；显式清空专用 URL，仅验证可加载，不计集成通过 |
| 严格 runner 缺 URL 反例 | cleanup 入口实际 exit 1，未启动 fixture |
| Docker / 真 PG/Redis / Provider / E2E / 部署 | 均未执行；CI 已配置但未推送或触发 |

原 Web loader 失败已修复；并行侧栏和测试更新保持。独立审查提出的六项 CI/Stream/Docker 问题已修正并复核为 OK with notes；随后全仓复跑通过。R-05 最终内容擦除和真实目标环境验收仍未完成，不由本地绿色测试推断。

## 原审计环境与基线

- 分支 `dev`，基线 HEAD `308ccca`（审计开始时）。开始时工作区已有 30 个 tracked path 修改与 3 个 untracked path；执行中 Web 文件 diff 继续变化。未清理、覆盖或 reset 任何既有用户文件。
- Node `v24.22.1`（最终测试运行器日志；此前 version probe 被 shell command-chain abort），pnpm `12.9.1`；依赖已安装。未读取 `.env` 或凭据。
- 未启动 HTTP/Worker 服务、PostgreSQL/Redis、容器，未部署，未运行真实 Provider/e2e smoke。以下 package tests 大多为单元或 mock；24 个 migration tests 由数据库审计 Agent 运行，使用模拟 Runner，不代表真实 PG 行为。

## 清理前验证

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 审计早期通过；之后工作区 Web 文件发生变化。 |
| `pnpm lint` | 退出 0；报告 87 warnings、0 errors。 |
| `pnpm test` | 首次全仓执行在 60 秒工具时限内未结束，不能将中断记为测试结果。后续串行全仓复跑中 Web 用例 `SessionSidebar supports deleting, clearing, pinning, and inline renaming recent sessions` 断言预期 2、实际 0。 |
| `pnpm build` | 较早全仓快照中 Next Web build 报 `Invariant: no direct app page entry found for /_not-found`；后续源码变化后以最终全仓串行构建重新验证。 |

## 清理后定向验证

| 命令 | 结果 |
|---|---|
| `pnpm --filter @musecanvas/api typecheck` | 通过。 |
| `pnpm --filter @musecanvas/api lint` | 退出 0；87 warnings、0 errors。 |
| `pnpm --filter @musecanvas/api exec node --import tsx --test "src/**/*.test.ts"` | 515 tests：515 pass，0 fail。 |
| `pnpm --filter @musecanvas/api build` | 独立构建通过，生成 API catch-all 页面。 |
| `pnpm --filter @musecanvas/providers typecheck` | 通过。 |
| `pnpm --filter @musecanvas/providers lint` | 退出 0；43 warnings、0 errors。 |
| `pnpm --filter @musecanvas/providers exec node --import tsx --test "src/**/*.test.ts"` | 241 pass，0 fail。 |
| `pnpm --filter @musecanvas/worker test` | 297 pass，0 fail。 |
| `pnpm --filter @musecanvas/database test` | 343 pass，0 fail。 |
| `pnpm --filter @musecanvas/media-service test` | 26 pass，0 fail。 |
| `pnpm --filter @musecanvas/contracts test` | 74 pass，0 fail。 |
| `pnpm --filter @musecanvas/domain test` | 33 pass，0 fail。 |
| `pnpm --filter @musecanvas/database exec node --import tsx --test src/migrations/migrations.test.ts src/migrations/runner.test.ts` | 24/24 pass（Agent D 运行）；迁移文件/模拟 runner 检查，非真实数据库测试。 |
| `pnpm install --lockfile-only --frozen-lockfile --ignore-scripts` | 通过；lockfile 与 workspace manifests 一致。 |
| `git diff --check` | 多次执行通过。 |
| Git 状态 / ignore 规则检查 | 五份交付文档因精确 `.gitignore` 例外可被跟踪；其他 `docs/*` 忽略规则保留。 |

## 原审计收尾验证（历史串行快照）

| 命令 | 结果 |
|---|---|
| `pnpm -r --workspace-concurrency=1 --if-present typecheck` | 最新复跑通过，所有 workspace typecheck 命令退出 0。早期快照曾因 Web 文件持续编辑报错；该结果已被最新快照复验取代。 |
| `pnpm lint` | 退出 0；warning 非零（API 87、Providers 43 等），无 lint errors。 |
| `pnpm -r --workspace-concurrency=1 --if-present test` | 最新串行复跑未通过，Web workspace 为 189 项，187 pass / 2 fail：① SessionSidebar 生命周期测试断言 0≠2；② 未跟踪 `attachment-references.test.mjs` 因 Node ESM 无法解析 workspace `packages/contracts/src/endpoints` 报 `ERR_MODULE_NOT_FOUND`。失败文件属于已有用户工作区，不属于本次清理。除 Web 外各 package suite 已分别运行并通过（见上表）。 |
| `pnpm -r --workspace-concurrency=1 --if-present build` | 最新串行 workspace build 通过；API 与 Web Next.js 生产构建及其他 workspace build 均退出 0。构建日志仍含 CSS/既存 lint warnings。 |
| Docker / real PG/Redis integration | 未运行：未启动服务/容器，未确认目标数据库环境；不触碰部署凭据或真实数据。 |

## 原审计解读与限制（历史；当前结果见文首）

1. Providers 依赖移除有 package-specific typecheck/lint/test 证据；Web 字体的移除有源码搜索和 lockfile 对照，最终全仓 build/typecheck 通过，但 Web 专属测试仍有两个工作区问题。
2. API helper 删除的 API typecheck/lint/test/build 全部通过；这不替代外部调用方检查，但该 helper 不是 HTTP route，也无其他调用。
3. Web 用户文件在任务期间持续变化，因此每次结果都按实际快照记载；最终 typecheck/build 通过，不能抹去最新 test 失败。
4. 真实 PostgreSQL 并发、Redis group retention、Docker clean-context 构建、公开 HTTP/鉴权/CSRF/SSE、部署 flags 与真实 Provider 端到端行为均未验证。
5. 未配置 URL 的 integration tests 不计为通过；mock/unit tests 不等价于真实运行时验证。
