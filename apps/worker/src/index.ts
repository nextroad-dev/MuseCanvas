import { redis } from './shared/infra'
import { consume } from './queue'
import { processJob } from './jobs'
import { maintenance } from './maintenance'

async function main() {
  await redis.connect(); await maintenance(); setInterval(() => maintenance().catch(error => console.error('maintenance failed', { code: error instanceof Error ? error.name : 'ERROR' })), 5000); await consume(processJob)
}
main().catch(error => { console.error('worker fatal', { code: error instanceof Error ? error.name : 'ERROR' }); process.exit(1) })
