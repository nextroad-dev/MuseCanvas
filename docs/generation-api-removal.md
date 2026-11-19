# 生成 API 移除（Agent-only 媒体生成）

2026-11-19 决策：媒体生成（文生图、图生图、局部修改、视频）不再是面向客户端的 REST 能力，
只作为 Agent 工具执行。本文件记录本次删除的范围、保留的接口与后续注意事项。

## 已删除

### HTTP 路由

| 方法 | 路径 | 原实现 |
|---|---|---|
| POST | `/api/generations` | `apps/api/src/modules/generations/create.ts`（文生图/图生图/视频创建） |
| POST | `/api/images/edit` | `apps/api/src/modules/image-edit/handlers.ts:editImage`（直连局部修改） |

路由表、`API_ENDPOINTS.generations`、`API_ENDPOINTS.images.edit` 以及 web 侧
`clientApi.generations.create`、`clientApi.images.edit`、`toGenerationRequest()` 一并移除。

### 内部代码

- `apps/api/src/modules/generations/` 整个模块（`create.ts` 删除，其余文件已迁至
  `apps/api/src/modules/jobs/` 或 `packages/media-service`）。
- `apps/api/src/modules/jobs/create-job.ts`：仅服务于被删除路由的 HTTP adapter，
  已无生产调用方（Worker 直接用 `packages/media-service` 的
  `prepareGeneration` + `createGenerationInTransaction`）。
- `ImageEditPorts.createJob` 端口及 `editImage` 的大量 multipart/幂等测试。

## 保留

- `POST /api/images/edit/preparations`：Agent 局部修改的**暂存**入口。只写入
  source/mask 与 `agent_media_mask_preparations` 身份，从不创建生成任务。
- `GET /api/jobs`、`GET /api/jobs/:id`、`POST /api/jobs/:id/cancel`、
  `POST /api/jobs/:id/retry`、`DELETE /api/jobs/:id`：历史任务查询、取消、重试与删除。
- `POST /api/generation-uploads`、`POST /api/generation-uploads/:id/complete`、
  `DELETE /api/generation-uploads/:id`：Agent 附件与参考图暂存。
- `packages/media-service` 的共享创建/编辑命令、`generation_jobs` 数据与 Outbox
  闭环、Worker 的 `generate_image` / `edit_image` / `generate_video` 工具。

## 数据

`generation_jobs`、`generation_job_inputs`、`generation_input_images`、
`generation_outputs`、`outbox_events` 等表保持不变；已有任务、资产与图库读取不受影响。
本次改动不执行任何数据删除。

## 验证

- `pnpm --filter @musecanvas/api typecheck` / `test`（403 通过）
- `pnpm --filter @musecanvas/contracts typecheck` / `test`（68 通过）
- `pnpm --filter @musecanvas/web typecheck` / `test`（183 通过）
- `pnpm --filter @musecanvas/media-service typecheck` / `test`（28 通过）
- `pnpm --filter @musecanvas/worker typecheck`、`pnpm --filter @musecanvas/database typecheck`
- `tests/integration/media-commands-pg.test.ts` 已改为直接调用共享命令（需显式 PG 夹具才运行）。
