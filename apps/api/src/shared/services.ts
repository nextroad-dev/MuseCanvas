import nodemailer from 'nodemailer'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { db } from '../../../../packages/database/src/index'
import { decryptSecret } from '../auth/security'

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const saved = await db().query('SELECT * FROM smtp_settings WHERE singleton=true')
  const row = saved.rows[0]
  const host = row?.host || process.env.SMTP_HOST; const port = row?.port || Number(process.env.SMTP_PORT || 1025)
  if (!host) throw new Error('SMTP_NOT_CONFIGURED')
  const mode = row?.tls_mode || process.env.SMTP_TLS_MODE || 'none'
  if (process.env.NODE_ENV === 'production' && mode === 'none' && process.env.ALLOW_INSECURE_SMTP !== 'true') throw new Error('SMTP_ENCRYPTION_REQUIRED')
  const user = row?.username || process.env.SMTP_USER || ''; const encrypted = row?.password_encrypted
  const password = encrypted ? decryptSecret(encrypted) : process.env.SMTP_PASSWORD || ''
  const transport = nodemailer.createTransport({ host, port, secure: mode === 'implicit_tls', requireTLS: mode === 'starttls', auth: user ? { user, pass: password } : undefined })
  await transport.sendMail({ from: { address: row?.from_address || process.env.SMTP_FROM || 'no-reply@musecanvas.local', name: row?.from_name || 'MuseCanvas' }, to, subject, text })
}

function s3(): S3Client { return new S3Client({ endpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT, region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID || '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '' } }) }
export async function signedAssetUrl(objectKey: string): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey }), { expiresIn: Number(process.env.S3_SIGNED_URL_TTL || 300) })
}
