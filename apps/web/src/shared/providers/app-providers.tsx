'use client'

import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

import { ToastProvider } from '@/shared/components/ui/toast'
import { createQueryClient } from './query-client'

/**
 * 应用级 Provider（必须留在 Client 边界内）。
 *
 * 只保留两类真正需要 Client 的能力：TanStack Query（服务端状态缓存）与 Toast
 * （全局瞬时反馈）。主题切换不依赖 React context —— 它直接写 `<html>.dark` 与
 * localStorage，由 `ThemeBootScript` 负责首帧，避免多一层 Provider 与 hydration
 * 抖动。QueryClient 用 `useState` 惰性创建一次，避免每次渲染重建缓存。
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  )
}
