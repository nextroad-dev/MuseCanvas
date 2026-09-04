import { redis } from './shared/infra'
import { consume } from './queue'
import { processJob } from './jobs'
import { maintenance } from './maintenance'

async function main() {
  await redis.connect()
  let running = false
  const runMaintenance = async () => {
    if (running) return
    running = true
    try { await maintenance() }
    catch (error) { console.error('maintenance failed', { code: error instanceof Error ? error.name : 'ERROR' }) }
    finally { running = false }
  }
  await runMaintenance()
  setInterval(runMaintenance, 5000)
  await consume(processJob)
}
main().catch(error => { console.error('worker fatal', { code: error instanceof Error ? error.name : 'ERROR' }); process.exit(1) })
