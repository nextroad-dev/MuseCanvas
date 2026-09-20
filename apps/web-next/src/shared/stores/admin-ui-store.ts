import { create } from 'zustand'

export type AdminTab =
  | 'dashboard'
  | 'users'
  | 'settings'
  | 'registration'
  | 'models'
  | 'templates'

export interface AdminUiState {
  activeTab: AdminTab
  selectedUserId: string | null
  inviteModalOpen: boolean
  searchQuery: string
  statusFilter: string

  // Actions
  setActiveTab: (tab: AdminTab) => void
  setSelectedUserId: (id: string | null) => void
  setInviteModalOpen: (open: boolean) => void
  setSearchQuery: (q: string) => void
  setStatusFilter: (status: string) => void
}

export const useAdminUiStore = create<AdminUiState>((set) => ({
  activeTab: 'dashboard',
  selectedUserId: null,
  inviteModalOpen: false,
  searchQuery: '',
  statusFilter: 'all',

  setActiveTab: (activeTab) => set({ activeTab }),
  setSelectedUserId: (selectedUserId) => set({ selectedUserId }),
  setInviteModalOpen: (inviteModalOpen) => set({ inviteModalOpen }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
}))
