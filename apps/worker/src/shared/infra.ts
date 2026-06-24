import { randomUUID } from 'node:crypto'
import { S3Client } from '@aws-sdk/client-s3'
import { createClient } from 'redis'

export const redis = createClient({ url: process.env.REDIS_URL }); redis.on('error', error => console.error('redis error', { code: error.name }))
export const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION || 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID || '', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '' } })
export const bucket = process.env.S3_BUCKET || 'musecanvas'
export const consumer = `worker-${process.pid}-${randomUUID().slice(0, 8)}`
