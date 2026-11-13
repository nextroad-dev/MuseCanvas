'use client'

// /generate 输出类型：`selectMode` = 设置类型并跳转创作台（图库灯箱「局部修改」入口使用）。
// 先写 store 再 push，保证创作台首帧就是目标类型，不闪一下另一种模式。

import { useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useGenerateUiStore, type GenerateKind } from '@/shared/stores/generate-ui-store'
import { APP_ROUTES, isOnGenerate } from '@/shared/lib/app-routes'

export function useGenerationMode() {
  const router = useRouter()
  const pathname = usePathname()
  const activeKind = useGenerateUiStore((state) => state.activeKind)
  const setActiveKind = useGenerateUiStore((state) => state.setActiveKind)

  const selectMode = useCallback(
    (next: GenerateKind) => {
      useGenerateUiStore.getState().setActiveKind(next)
      if (isOnGenerate(pathname)) return
      router.push(APP_ROUTES.generate)
    },
    [pathname, router],
  )

  return { activeKind, setActiveKind, selectMode }
}
