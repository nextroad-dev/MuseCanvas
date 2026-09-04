// Pure decisions for setup access: completed onboarding stays closed to
// anonymous/non-admin users, while authenticated admins may revisit /setup to
// edit the persisted configuration. No Vue/router imports so node:test can
// cover the matrix directly.
export type SetupGuardRedirect = '/setup' | '/admin'

export function resolveSetupGuardRedirect(options: {
  setupComplete: boolean
  statusFailed: boolean
  isSetupRoute: boolean
  isLegalPublicRoute: boolean
  isAdmin: boolean
}): SetupGuardRedirect | null {
  // A transport/API failure is never treated as "setup incomplete".
  if (options.statusFailed) return null
  if (!options.setupComplete) {
    if (options.isSetupRoute) return null
    if (options.isLegalPublicRoute) return null
    return '/setup'
  }
  // Onboarding is done: only admins may stay on the wizard. Everyone else is
  // funneled to /admin so the normal auth/admin handling applies
  // (anonymous -> /login, non-admin -> /generate).
  if (options.isSetupRoute) {
    return options.isAdmin ? null : '/admin'
  }
  return null
}

export function resolveCompletedSetupPageRedirect(options: {
  setupComplete: boolean
  statusFailed: boolean
  isAdmin: boolean
}): '/admin' | null {
  if (options.statusFailed) return null
  if (!options.setupComplete) return null
  return options.isAdmin ? null : '/admin'
}
