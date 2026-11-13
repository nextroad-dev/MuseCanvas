import { QueryClient } from '@tanstack/react-query'

/**
 * TanStack Query 的唯一默认值来源。
 *
 * 服务端状态（会话、模型、任务、图库、后台数据）都以后端为权威：请求失败重试一次
 * 即可，重试更多次只会在后端抖动时制造请求噪音；窗口重新聚焦不强制重取，避免切
 * 标签页回来时整页骨架闪烁。具体 hook 可按需覆盖 `staleTime`（如模型目录 5 分钟）。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
      },
      mutations: {
        retry: 0,
      },
    },
  })
}
