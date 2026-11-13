// 登录表单易失 UI 态（邮箱 → 6 位验证码两步）。会话本身由 TanStack Query 托管。

import { create } from 'zustand'

export type AuthStep = 'email' | 'code'

export interface AuthUiState {
  step: AuthStep
  /** 第一步提交的邮箱；验证码步骤据此复用，避免重复输入。 */
  email: string
  /** 邀请制注册：第一步是否需要邀请码。 */
  requiresInvitation: boolean

  setStep: (step: AuthStep) => void
  setEmail: (email: string) => void
  setRequiresInvitation: (required: boolean) => void
  reset: () => void
}

export const useAuthUiStore = create<AuthUiState>((set) => ({
  step: 'email',
  email: '',
  requiresInvitation: false,

  setStep: (step) => set({ step }),
  setEmail: (email) => set({ email }),
  setRequiresInvitation: (requiresInvitation) => set({ requiresInvitation }),
  reset: () => set({ step: 'email', email: '', requiresInvitation: false }),
}))
