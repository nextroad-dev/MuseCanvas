// 图库易失 UI 态：列数、多选、筛选条件。列表数据本身由 TanStack Query 托管。

import { create } from 'zustand'
import type { MediaKind } from '@/shared/types'

export type LibraryTab = 'all' | MediaKind

export interface LibraryFilters {
  tab: LibraryTab
  /** 提示词关键词（服务端 `q`）。 */
  q: string
}

export interface LibraryUiState {
  /** 网格列数；默认 3 列（舒适）。 */
  columns: 2 | 3 | 4 | 6
  selectedIds: string[]
  filters: LibraryFilters

  setColumns: (columns: 2 | 3 | 4 | 6) => void
  setTab: (tab: LibraryTab) => void
  setQuery: (q: string) => void
  toggleSelect: (id: string) => void
  selectMany: (ids: string[]) => void
  clearSelection: () => void
}

export const useLibraryUiStore = create<LibraryUiState>((set) => ({
  columns: 3,
  selectedIds: [],
  filters: { tab: 'all', q: '' },

  setColumns: (columns) => set({ columns }),
  // 切 tab 会改变列表内容：清空多选，避免删除「看不见的已选项」。
  setTab: (tab) => set((state) => ({ filters: { ...state.filters, tab }, selectedIds: [] })),
  setQuery: (q) => set((state) => ({ filters: { ...state.filters, q } })),
  toggleSelect: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((item) => item !== id)
        : [...state.selectedIds, id],
    })),
  selectMany: (ids) => set({ selectedIds: [...new Set(ids)] }),
  clearSelection: () => set({ selectedIds: [] }),
}))
