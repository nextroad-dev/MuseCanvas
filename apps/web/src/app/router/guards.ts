import type { Router } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'
import { useSetupStore } from '@/features/setup/stores/setup'

// Pure-public legal pages stay reachable while the wizard is incomplete;
// everything else (including guest pages such as /login and /) funnels into
// /setup until onboarding completes.
const LEGAL_PUBLIC_NAMES = new Set(['terms', 'privacy'])

export function setupGuards(router: Router) {
  let setupChecked = false

  async function ensureSetupChecked() {
    const setup = useSetupStore()
    if (!setupChecked && !setup.checked) {
      await setup.checkStatus()
      setupChecked = true
    }
    return setup
  }

  router.beforeEach(async (to) => {
    const auth = useAuthStore()
    const setup = await ensureSetupChecked()

    // A transport/API failure is NOT "setup incomplete": never force a
    // redirect on it, just fall through to the normal auth handling below.
    if (!setup.statusFailed) {
      if (!setup.setupComplete) {
        if (to.name !== 'setup' && !(to.meta.public && LEGAL_PUBLIC_NAMES.has(to.name as string))) {
          return { path: '/setup' }
        }
      } else if (to.name === 'setup') {
        // Onboarding is done; the wizard itself redirects onward to admin
        // (the requiresAdmin handling below sends logged-out users to login).
        return { path: '/admin' }
      }
    }

    // Public pages (e.g. legal, setup) — accessible whether logged in or not
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
