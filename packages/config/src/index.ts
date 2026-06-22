function required(name: string, fallback?: string): string {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export const config = {
  databaseUrl: () => required('DATABASE_URL'),
  redisUrl: () => required('REDIS_URL'),
  sessionSecret: () => required('SESSION_SECRET'),
  smtpEncryptionKey: () => required('SMTP_ENCRYPTION_KEY'),
  s3: () => ({ endpoint: required('S3_ENDPOINT'), region: required('S3_REGION', 'us-east-1'), bucket: required('S3_BUCKET'), accessKeyId: required('S3_ACCESS_KEY_ID'), secretAccessKey: required('S3_SECRET_ACCESS_KEY') }),
}
