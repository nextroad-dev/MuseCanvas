import type { OnboardingSectionKey, SetupStatusResponse } from '@musecanvas/contracts'

/** Missing data is unknown, not pending or complete. */
export function isSetupStepComplete(sections: OnboardingSectionKey[], status?: SetupStatusResponse | null): boolean {
  return Boolean(status && sections.length && sections.every(key => status.sections[key]?.status === 'complete'))
}
