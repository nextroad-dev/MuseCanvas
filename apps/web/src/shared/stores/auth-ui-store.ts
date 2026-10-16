import { create } from 'zustand'

/**
 * Volatile auth UI state only.
 *
 * The session itself (user / isAuthenticated) is server state and lives in
 * TanStack Query (`useAccountQuery`); this store must never mirror it.
 */
export interface AuthUiState {
  loginModalOpen: boolean
  redirectPath: string | null

  // Actions
  setLoginModalOpen: (loginModalOpen: boolean) => void
  setRedirectPath: (redirectPath: string | null) => void
}

export const useAuthUiStore = create<AuthUiState>((set) => ({
  loginModalOpen: false,
  redirectPath: null,

  setLoginModalOpen: (loginModalOpen) => set({ loginModalOpen }),
  setRedirectPath: (redirectPath) => set({ redirectPath }),
}))
