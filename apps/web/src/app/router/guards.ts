import type { Router } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'

export function setupGuards(router: Router) {
  router.beforeEach(async (to) => {
    const auth = useAuthStore()

    // Public pages (e.g. legal) — accessible whether logged in or not
    if (to.meta.public) {
      return true
    }

    if (to.meta.guest) {
      if (auth.initialized) {
        return auth.isLoggedIn ? { path: auth.isAdmin ? '/admin' : '/generate' } : true
      }

      void auth.init().then(() => {
        const current = router.currentRoute.value
        if (current.meta.guest && auth.isLoggedIn) {
          void router.replace({ path: auth.isAdmin ? '/admin' : '/generate' })
        }
      })

      return true
    }

    // Initialize auth state before entering protected pages.
    if (!auth.initialized) {
      await auth.init()
    }

    const isLoggedIn = auth.isLoggedIn
    const isAdmin = auth.isAdmin

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
