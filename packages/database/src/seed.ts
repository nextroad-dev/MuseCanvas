import { db } from './index'

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
if (!email) {
  console.log('ADMIN_EMAIL not set; first admin will be created via onboarding wizard')
  await db().end()
  process.exit(0)
}
// DO NOTHING on conflict: never escalate or reactivate an existing user silently.
const res = await db().query(
  `INSERT INTO users(email, role) VALUES($1, 'admin')
   ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO NOTHING
   RETURNING id`,
  [email],
)
if (res.rows.length > 0) {
  console.log('administrator bootstrap complete: created admin user', email)
} else {
  console.log(`user ${email} already exists; left unchanged (grant admin privileges via the admin console if needed)`)
}
await db().end()
