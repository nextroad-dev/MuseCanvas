import { db } from './index'

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
if (!email) throw new Error('ADMIN_EMAIL is required for controlled administrator bootstrap')
await db().query(`INSERT INTO users(email,role) VALUES($1,'admin') ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO UPDATE SET role='admin',status='active',updated_at=now()`, [email])
console.log('administrator bootstrap complete')
await db().end()
