import { createServer } from 'node:http'

/** Progress checks stay local to this worker; no payloads or credentials are exposed. */
export function createWorkerHealth(now: () => number = Date.now) {
  let queueAt: number | null = null
  let scheduleAt: number | null = null
  return {
    queueProgress() { queueAt = now() },
    scheduleProgress() { scheduleAt = now() },
    ready() {
      const time = now()
      return queueAt !== null && scheduleAt !== null && time - queueAt < 120_000 && time - scheduleAt < 60_000
    },
  }
}

export function startHealthServer(health: ReturnType<typeof createWorkerHealth>) {
  const port = Number(process.env.WORKER_HEALTH_PORT || 3010)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_WORKER_HEALTH_PORT')
  const server = createServer((request, response) => {
    const ready = health.ready()
    response.writeHead(request.url === '/health' ? (ready ? 200 : 503) : 404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: ready ? 'ready' : 'unavailable' }))
  })
  server.on('error', () => { console.error('worker health server failed', { code: 'WORKER_HEALTH_SERVER_FAILED' }); process.exit(1) })
  server.listen(port, '127.0.0.1')
  return server
}
