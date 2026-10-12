/** A synchronous single-flight gate. Stale/aborted responses cannot change login steps. */
export function createLoginRequestGate() {
  let sequence = 0
  let active: { id: number; controller: AbortController } | null = null
  return {
    begin() {
      if (active) return null
      active = { id: ++sequence, controller: new AbortController() }
      return { id: active.id, signal: active.controller.signal }
    },
    current(id: number) { return active?.id === id && !active.controller.signal.aborted },
    finish(id: number) { if (active?.id === id) active = null },
    cancel() { active?.controller.abort(); active = null; sequence++ },
  }
}
