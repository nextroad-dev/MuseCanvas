import type { Router } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'
import { useSetupStore } from '@/features/setup/stores/setup'

export function setupGuards(router: Router) {
  let setupChecked = false

  router.beforeEach(async (to) => {
    const auth = useAuthStore()

    // Public pages (e.g. legal, setup) — accessible whether logged in or not
    if (to.meta.public) {
      return true
    }

    // Check setup status on first navigation (skip for /setup itself)
    if (!setupChecked && to.name !== 'setup') {
      const setup = useSetupStore()
      await setup.checkStatus()
      setupChecked = true
      if (!setup.setupComplete && to.name !== 'setup') {
        return { path: '/setup' }
      }
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