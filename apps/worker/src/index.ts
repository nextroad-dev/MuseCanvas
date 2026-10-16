import { assertBootstrapConfig } from '@musecanvas/config'
import { redis } from './shared/infra'
import { consume } from './queue'
import { processJob } from './jobs'
import { maintenance } from './maintenance'
import { PLUGIN_BOOT_REFRESH_BUDGET_MS, refreshPlugins } from './plugins/loader'
import { assertBuiltinPluginsAvailable } from './plugins/availability'
import { runCredentialTests } from './credentials/probe'

async function main() {
  // Imports above stay side-effect free (no S3/DB connects at module load),
  // so this assertion is the single fail-fast gate: missing DATABASE_URL,
  // REDIS_URL, APP_MASTER_KEY, or NODE_ENV exits BOOTSTRAP_CONFIG_INVALID
  // before any queue or maintenance work starts. S3 is still not required
  // here; storage resolves lazily on first use.
  assertBootstrapConfig()
  await redis.connect()
  // Every job path resolves through the availability gate, so verify here — not by
  // assumption — that the built-in keys (media and language) it short-circuits really resolve.
  assertBuiltinPluginsAvailable()
  // The plugin catalog refresh is never allowed to gate boot: it swallows its own
  // errors and runs under a deadline, because a worker without S3 configured (or
  // with one wedged artifact) must still serve the built-in plugins. Installed
  // plugins stay unavailable with PROVIDER_NOT_CONFIGURED until it lands.
  const refreshCatalog = async () => {
    try {
      const result = await refreshPlugins()
      if (result.changed || result.loaded || result.failed) console.log('plugin catalog refreshed', { code: 'PLUGIN_CATALOG_REFRESHED', rows: result.rows, loaded: result.loaded, failed: result.failed })
    } catch (error) { console.error('plugin catalog refresh failed', { code: error instanceof Error ? error.name : 'ERROR' }) }
  }
  await Promise.race([
    refreshCatalog(),
    new Promise<void>(resolve => { setTimeout(resolve, PLUGIN_BOOT_REFRESH_BUDGET_MS).unref() }),
  ])
  let running = false
  const runMaintenance = async () => {
    if (running) return
    running = true
    try {
      await refreshCatalog()
      await maintenance()
    }
    catch (error) { console.error('maintenance failed', { code: error instanceof Error ? error.name : 'ERROR' }) }
    finally { running = false }
  }
  await runMaintenance()
  setInterval(runMaintenance, 5000)
  // Credential tests have an admin waiting on them, so they get their own short
  // cadence instead of queueing behind maintenance or a long generation job.
  let testing = false
  setInterval(async () => {
    if (testing) return
    testing = true
    try { await runCredentialTests() }
    catch (error) { console.error('credential tests failed', { code: error instanceof Error ? error.name : 'ERROR' }) }
    finally { testing = false }
  }, 2000)
  await consume(processJob)
}
main().catch(error => { console.error('worker fatal', { code: error instanceof Error ? error.name : 'ERROR' }); process.exit(1) })
