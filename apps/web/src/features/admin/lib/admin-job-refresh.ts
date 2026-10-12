export const ADMIN_JOB_REFRESH_MS = 15_000

/** Only the first (latest) cursor batch is eligible for foreground polling. */
export function shouldPollAdminJobs(enabled: boolean, visible: boolean, batch: number): boolean {
  return enabled && visible && batch === 1
}
