import { SetupWizardSkeleton } from '@/features/setup/components/setup-wizard-skeleton'

/**
 * Route-level loading state. It reuses the wizard's own skeleton so the header,
 * stepper band and panel keep the same geometry when the real wizard mounts.
 */
export default function SetupLoading() {
  return <SetupWizardSkeleton />
}
