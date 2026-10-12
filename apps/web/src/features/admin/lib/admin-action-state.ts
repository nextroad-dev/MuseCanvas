export type AdminActionKind = 'toggle' | 'delete' | 'test' | 'other'

/** The active toggle retains focus; other operations (including a server test) block it. */
export function isAdminToggleBlocked(kind: AdminActionKind | undefined, serverTestPending = false): boolean {
  return kind === 'toggle' ? false : kind !== undefined || serverTestPending
}

/** Object-scoped synchronous lock. Template version forks pass a shared serial key. */
export function createAdminActionLock() {
  const pending = new Map<string, AdminActionKind>()
  return {
    claim(id: string, kind: AdminActionKind = 'other'): boolean {
      if (pending.has(id)) return false
      pending.set(id, kind)
      return true
    },
    release: (id: string) => { pending.delete(id) },
    has: (id: string) => pending.has(id),
    kind: (id: string) => pending.get(id),
  }
}
