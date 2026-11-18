/** Serial background sweeps stop admission on abort and expose an explicit drain. */
export function createDrainingSweep(signal: AbortSignal, work: () => Promise<void>) {
  let active: Promise<void> | undefined
  return {
    run(): Promise<void> {
      if (signal.aborted) return Promise.resolve()
      if (active) return active
      const task = Promise.resolve().then(() => signal.aborted ? undefined : work())
      active = task
      // Install rejection handling immediately; the caller still observes task's error.
      void task.then(() => { if (active === task) active = undefined }, () => { if (active === task) active = undefined })
      return task
    },
    async drain(): Promise<void> { await active },
  }
}
