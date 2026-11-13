'use client'

import { create } from 'zustand'
import { consumeReuseQuery, type ReuseDraft } from '../lib/generate-reuse'

/** Draft only; models, tasks and results remain owned by TanStack Query. */
export const useComposerStore = create<ReuseDraft & {
  setPrompt: (prompt: string) => void
  setRequestedKind: (requestedKind: string) => void
  consumeQuery: (query: string) => void
}>((set) => ({
  prompt: '',
  requestedKind: 'image',
  lastReuseQuery: '',
  setPrompt: (prompt) => set({ prompt }),
  setRequestedKind: (requestedKind) => set({ requestedKind }),
  consumeQuery: (query) => set((state) => consumeReuseQuery(state, query)),
}))
