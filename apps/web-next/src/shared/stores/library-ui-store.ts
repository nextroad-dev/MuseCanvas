import { create } from 'zustand'

export type LibraryFilterKind = 'all' | 'image' | 'video'

export interface LibraryUiState {
  filterKind: LibraryFilterKind
  filterFavorite: boolean
  searchQuery: string
  sortOrder: 'desc' | 'asc'
  viewMode: 'grid' | 'masonry'
  columnCount: 2 | 3 | 4 | 6
  selectedAssetIds: string[]
  previewAssetId: string | null

  // Actions
  setFilterKind: (filterKind: LibraryFilterKind) => void
  setFilterFavorite: (filterFavorite: boolean) => void
  setSearchQuery: (searchQuery: string) => void
  setSortOrder: (sortOrder: 'desc' | 'asc') => void
  setViewMode: (viewMode: 'grid' | 'masonry') => void
  setColumnCount: (columnCount: 2 | 3 | 4 | 6) => void
  toggleSelectAsset: (id: string) => void

  selectAllAssets: (ids: string[]) => void
  clearSelectedAssets: () => void
  setPreviewAssetId: (id: string | null) => void
}

export const useLibraryUiStore = create<LibraryUiState>((set) => ({
  filterKind: 'all',
  filterFavorite: false,
  searchQuery: '',
  sortOrder: 'desc',
  viewMode: 'grid',
  columnCount: 4,
  selectedAssetIds: [],
  previewAssetId: null,

  setFilterKind: (filterKind) => set({ filterKind }),
  setFilterFavorite: (filterFavorite) => set({ filterFavorite }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSortOrder: (sortOrder) => set({ sortOrder }),
  setViewMode: (viewMode) => set({ viewMode }),
  setColumnCount: (columnCount) => set({ columnCount }),

  toggleSelectAsset: (id) =>
    set((state) => {
      const exists = state.selectedAssetIds.includes(id)
      return {
        selectedAssetIds: exists
          ? state.selectedAssetIds.filter((item) => item !== id)
          : [...state.selectedAssetIds, id],
      }
    }),

  selectAllAssets: (ids) => set({ selectedAssetIds: ids }),
  clearSelectedAssets: () => set({ selectedAssetIds: [] }),
  setPreviewAssetId: (previewAssetId) => set({ previewAssetId }),
}))
