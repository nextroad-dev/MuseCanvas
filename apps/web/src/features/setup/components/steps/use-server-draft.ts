'use client'

import { useState } from 'react'

/**
 * Draft that follows the stored settings. The draft is replaced only when the server
 * reports a newer revision, so a background refetch never discards typed input and a
 * saved value is adopted as the new baseline. Write-only secrets are cleared by `toDraft`.
 */
export function useServerDraft<T extends { revision: number }, D>(settings: T, toDraft: (next: T) => D) {
  const [baseline, setBaseline] = useState(settings)
  const [draft, setDraft] = useState<D>(() => toDraft(settings))

  if (settings.revision !== baseline.revision) {
    setBaseline(settings)
    setDraft(toDraft(settings))
  }

  return {
    baseline,
    draft,
    setDraft,
    adopt(next: T) {
      setBaseline(next)
      setDraft(toDraft(next))
    },
  }
}
