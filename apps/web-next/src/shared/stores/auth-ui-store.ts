import { create } from 'zustand'
import type { UserProfile } from '@/shared/types'

export interface AuthUiState {
  user: UserProfile | null
  isAuthenticated: boolean
  isLoading: boolean
  loginModalOpen: boolean
  redirectPath: string | null

  // Actions
  setUser: (user: UserProfile | null) => void
  setIsLoading: (isLoading: boolean) => void
  setLoginModalOpen: (loginModalOpen: boolean) => void
  setRedirectPath: (redirectPath: string | null) => void
  clearAuth: () => void
}

export const useAuthUiStore = create<AuthUiState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  loginModalOpen: false,
  redirectPath: null,

  setUser: (user) =>
    set({
      user,
      isAuthenticated: Boolean(user),
      isLoading: false,
    }),

  setIsLoading: (isLoading) => set({ isLoading }),
  setLoginModalOpen: (loginModalOpen) => set({ loginModalOpen }),
  setRedirectPath: (redirectPath) => set({ redirectPath }),

  clearAuth: () =>
    set({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    }),
}))
