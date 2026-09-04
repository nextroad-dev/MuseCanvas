import { assertBootstrapConfig } from '../../../packages/config/src/index'
import { redis } from './shared/infra'
import { consume } from './queue'
import { processJob } from './jobs'
import { maintenance } from './maintenance'

async function main() {
  // Imports above stay side-effect free (no S3/DB connects at module load),
  // so this assertion is the single fail-fast gate: missing DATABASE_URL,
  // REDIS_URL, APP_MASTER_KEY, or NODE_ENV exits BOOTSTRAP_CONFIG_INVALID
  // before any queue or maintenance work starts. S3 is still not required
  // here; storage resolves lazily on first use.
  assertBootstrapConfig()
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
