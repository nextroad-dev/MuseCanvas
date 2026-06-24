import type { Router } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'

export function setupGuards(router: Router) {
  router.beforeEach(async (to) => {
    const auth = useAuthStore()

    // Initialize auth state on first navigation
    if (!auth.initialized) {
      await auth.init()
    }

    const isLoggedIn = auth.isLoggedIn
    const isAdmin = auth.isAdmin

    // Guest-only pages (login)
    if (to.meta.guest && isLoggedIn) {
      return { path: isAdmin ? '/admin' : '/generate' }
    }

    // Pages requiring auth
    if (to.matched.some((r) => !r.meta.guest && !r.meta.requiresAdmin) && !isLoggedIn) {
      return { path: '/login' }
    }

    // Admin-only pages
    if (to.meta.requiresAdmin && !isLoggedIn) {
      return { path: '/login' }
    }

    if (to.meta.requiresAdmin && !isAdmin) {
      return { path: '/generate' }
    }

    return true
  })
}
