export const agentCoreEnabled = () => process.env.AGENT_CORE_ENABLED === 'true'
export const agentCoreAdmissionReady = () => process.env.AGENT_CORE_ADMISSION_READY === 'true'
/** Narrow namespace gate, including malformed/unregistered Core paths. Never matches legacy Canvas Agent. */
export const agentCorePathDisabled = (path: string) => (path === 'agent' || path.startsWith('agent/')) && !agentCoreEnabled()
