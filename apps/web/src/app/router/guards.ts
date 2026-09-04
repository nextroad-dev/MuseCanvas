import type { Router } from 'vue-router'
import { useAuthStore } from '@/features/auth/stores/auth'
import { useSetupStore } from '@/features/setup/stores/setup'
import { resolveSetupGuardRedirect } from './setupAdminAccess'

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

    // Completed setup stays closed to anonymous/non-admin users, while
    // authenticated admins may revisit /setup to edit persisted config.
    if (!setup.statusFailed) {
      const isSetupRoute = to.name === 'setup'
      const isLegalPublicRoute = Boolean(to.meta.public && LEGAL_PUBLIC_NAMES.has(to.name as string))
      // The completed-wizard decision needs the admin flag; incomplete setup
      // never does, so only initialize auth for that branch.
      if (setup.setupComplete && isSetupRoute && !auth.initialized) {
        await auth.init()
      }
      const redirect = resolveSetupGuardRedirect({
        setupComplete: setup.setupComplete,
        statusFailed: setup.statusFailed,
        isSetupRoute,
        isLegalPublicRoute,
        isAdmin: auth.isAdmin,
      })
      if (redirect) return { path: redirect }
      // An admin revisit must not fall into the public passthrough below
      // without an initialized auth state; it returns here instead.
      if (setup.setupComplete && isSetupRoute) return true
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
