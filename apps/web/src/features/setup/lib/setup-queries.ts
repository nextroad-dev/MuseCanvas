// 安装向导的 TanStack Query key（唯一来源）。请求函数直接来自 `clientApi.setup.*`，
// 这里只做 key 收敛，避免状态 / 配置 / 数据库三处各自拼字面量。

export const setupQueryKeys = {
  status: ['setup', 'status'] as const,
  config: ['setup', 'config'] as const,
  database: ['setup', 'database'] as const,
}
