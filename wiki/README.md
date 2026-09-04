# MuseCanvas Wiki

项目工程规范与决策记录。`docs/` 为本地笔记(.gitignore 排除),`wiki/` 为可入库共享的工程规范。

## 规范索引

| 文档 | 内容 |
|------|------|
| [视频插件开发规范](./video-plugin-spec.md) | media provider 内核契约、视频插件生命周期、安全边界、错误模型、测试门禁 |

## 适用范围

- `packages/providers/src/core/` — provider 内核(registry / safe http / output reader / errors)
- `packages/providers/src/plugins/` — 插件实现(`openai-image`、`seedream-image`、`seedance-video`、`veo-video`)
- `apps/worker/src/jobs/` — 插件消费端(任务状态机、输出摄取)
- `tests/integration/media-provider-contract.test.ts` — 契约门禁(无网络、无凭据、全 mock)
