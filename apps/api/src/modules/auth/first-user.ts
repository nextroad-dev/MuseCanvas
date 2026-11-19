import { markOnboardingSection, transaction } from '@musecanvas/database'
import { resolveClaimRequired } from '../setup/claim-required'

type Client = Parameters<Parameters<typeof transaction>[0]>[0]

export async function lockPendingOnboarding(client: Client): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM onboarding_state WHERE singleton=true AND status <> 'complete' FOR UPDATE")
  return result.rows.length > 0
}

export async function lockRegistrationOnboarding(client: Client): Promise<boolean> {
  return !resolveClaimRequired(process.env) && await lockPendingOnboarding(client)
}

/** The caller holds the onboarding lock while creating the first administrator. */
export async function createRegisteredUser(client: Client, email: string, onboardingPending: boolean) {
  const first = onboardingPending && (await client.query('SELECT 1 FROM users LIMIT 1')).rows.length === 0
  const { rows: [user] } = await client.query('INSERT INTO users(email,role) VALUES($1,$2) RETURNING *', [email, first ? 'admin' : 'user'])
  if (first) await markOnboardingSection(client, 'admin', 'complete', user.id)
  return user
}
