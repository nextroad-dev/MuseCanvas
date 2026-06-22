# Worker

独立 TypeScript 后台进程。队列消费者放在 `consumers`，可重试任务处理器放在
`jobs`，周期性恢复与清理逻辑放在 `schedulers`。

