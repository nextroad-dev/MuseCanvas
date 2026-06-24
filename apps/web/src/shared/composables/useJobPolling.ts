import { ref, onUnmounted } from 'vue'

interface PollingJob {
  id: string
  status: string
}

export function useJobPolling<T extends PollingJob>(
  jobs: () => T[],
  refreshFn: (id: string) => Promise<unknown>,
) {
  const inFlight = ref<Set<string>>(new Set())
  let timer: ReturnType<typeof setInterval> | null = null

  function isNonTerminal(status: string) {
    return ['queued', 'running', 'retry_wait'].includes(status)
  }

  async function pollOne(id: string) {
    if (inFlight.value.has(id)) return
    inFlight.value.add(id)
    try {
      await refreshFn(id)
    } catch {
      // Single failure: keep old data, don't toast
    } finally {
      inFlight.value.delete(id)
    }
  }

  function tick() {
    const active = jobs().filter((j) => isNonTerminal(j.status))
    active.forEach((j) => pollOne(j.id))
  }

  function start() {
    if (timer) return
    tick()
    timer = setInterval(tick, 3000)
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function restart() {
    stop()
    start()
  }

  // Pause when tab hidden
  function handleVisibility() {
    if (document.hidden) {
      stop()
    } else {
      tick()
      start()
    }
  }

  document.addEventListener('visibilitychange', handleVisibility)

  onUnmounted(() => {
    stop()
    document.removeEventListener('visibilitychange', handleVisibility)
  })

  return { start, stop, restart }
}
