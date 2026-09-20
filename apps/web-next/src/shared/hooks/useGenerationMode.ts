'use client'

import { useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import { GENERATE_ROUTE, isOnGenerate } from '@/shared/lib/app-routes'
import type { GenerateModeTab } from '@/shared/types'

/**
 * The workspace header's 作图 / 生视频 entries.
 *
 * The mode itself lives in `useGenerateUiStore.activeTab`; this only turns a
 * click into "switch mode, and get to `/generate` if we are not already there".
 *
 * Why it is not `<Link href="/generate?tab=video">`: the console honours `?tab=`
 * once per mount (see the projection in `generate-console.tsx`), so a
 * query-only change on the route it already sits on would be swallowed and the
 * second click would look dead. Writing the store is the reactive path, and it
 * also keeps a mode switch from costing a same-route RSC refetch.
 *
 * Order matters: `setActiveTab` runs *before* `push`, so the console's first
 * frame is already the requested mode instead of flashing 作图. Nothing appends
 * `?tab=` — the URL is an input to the mode, never a record of it.
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
