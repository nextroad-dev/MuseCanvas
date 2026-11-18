import { createHash } from 'node:crypto'

export const agentCoreEnabled = () => process.env.AGENT_CORE_ENABLED === 'true'

export function agentCoreRolloutBucket(actorId: string): number {
  return createHash('sha256').update(actorId).digest().readUInt32BE(0) % 100
}

function rolloutPercent(): number {
  const value = process.env.AGENT_ADMISSION_PERCENT
  if (value === undefined) return 100
  if (value === '' || /[^0-9]/.test(value)) return 0
  const percent = Number(value)
  return Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : 0
}

/** Rollout only controls new admission; existing turns remain readable and controllable. */
export function agentCoreAdmissionReady(actorId: string): boolean {
  if (process.env.AGENT_CORE_ADMISSION_READY !== 'true') return false
  const actors = (process.env.AGENT_ADMISSION_ACTORS ?? '').split(',')
    .map(value => value.trim())
    .filter(value => /^[A-Za-z0-9._:-]{1,128}$/.test(value))
    .slice(0, 1000)
  return actors.includes(actorId) || agentCoreRolloutBucket(actorId) < rolloutPercent()
}

/** Narrow namespace gate, including malformed/unregistered Core paths. Never matches legacy Canvas Agent. */
export const agentCorePathDisabled = (path: string) => (path === 'agent' || path.startsWith('agent/')) && !agentCoreEnabled()
