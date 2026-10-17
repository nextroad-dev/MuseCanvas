'use client'

import { useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import { GENERATE_ROUTE, isOnGenerate } from '@/shared/lib/app-routes'
import type { GenerateModeTab } from '@/shared/types'

/**
 * Programmatic jumps into the creation console with an output type.
 *
 * The workspace nav no longer calls this (it is two plain route links now);
 * the remaining caller is the library lightbox's 局部修改 entry
 * (`selectMode('image')`), which hands an asset over as a composer draft and
 * needs the console in image mode. `generate-console.tsx` keeps consuming the
 * same `activeTab` store plus the one-shot `?tab=` deep link, so old links and
 * bookmarks keep working.
 *
 * Order matters: `setActiveTab` runs *before* `push`, so the console's first
 * frame is already the requested mode instead of flashing the other one.
 * Nothing appends `?tab=` — the URL is an input to the mode, never a record
 * of it.
 */
export function useGenerationMode() {
  const router = useRouter()
  const pathname = usePathname()
  const mode = useGenerateUiStore((state) => state.activeTab)

  const selectMode = useCallback(
    (next: GenerateModeTab) => {
      useGenerateUiStore.getState().setActiveTab(next)
      if (isOnGenerate(pathname)) return
      router.push(GENERATE_ROUTE)
    },
    [pathname, router],
  )

  return { mode, selectMode }
}
