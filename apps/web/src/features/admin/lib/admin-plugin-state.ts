import type { QueryClient } from '@tanstack/react-query'

/** Plugin state changes also change the server-composed model and credential catalogs. */
export async function invalidateAdminPluginCatalogs(queryClient: QueryClient) {
  await Promise.all(['plugins', 'model-presets', 'provider-templates'].map((catalog) =>
    queryClient.invalidateQueries({ queryKey: ['admin', catalog] }),
  ))
}

/** Synchronous submission identity: duplicate clicks and late results cannot own a new package. */
export function createPluginSubmissionGuard() {
  let sequence = 0
  let active: number | null = null
  return {
    begin(): number | null {
      if (active !== null) return null
      active = ++sequence
      return active
    },
    isPending: () => active !== null,
    owns: (id: number) => active === id,
    finish(id: number): boolean {
      if (active !== id) return false
      active = null
      return true
    },
  }
}
