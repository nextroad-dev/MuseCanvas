import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import type { ResolvedS3StorageConfig } from '@musecanvas/database'
import { randomUUID } from 'node:crypto'
import {
  STORAGE_OBJECT_TOO_LARGE,
  STORAGE_TEST_FAILED,
  StorageDriverError,
  type PutIfAbsentOutcome,
  type SignedUpload,
  type StorageDriver,
  type StorageObjectStream,
} from './types'

// S3-compatible driver. Behaviour matches the pre-driver helpers exactly:
// server-side calls use endpoint, falling back to publicEndpoint; browser-facing
// signatures use publicEndpoint, falling back to endpoint.

function storageClient(endpoint: string | null, region: string, accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint: endpoint ?? undefined,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new StorageDriverError(STORAGE_TEST_FAILED)), timeoutMs)
  })
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer)
  })
}

function isPreconditionFailure(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
  return status === 409 || status === 412
}

export class S3StorageDriver implements StorageDriver {
  readonly kind = 's3' as const

  constructor(private readonly config: ResolvedS3StorageConfig) {}

  private get bucket(): string {
    return this.config.bucket ?? ''
  }

  private get accessKeyId(): string {
    return this.config.accessKeyId ?? ''
  }

  private get secretAccessKey(): string {
    return this.config.secretAccessKey ?? ''
  }

  /** Server-side calls: endpoint first. */
  private serverClient(): S3Client {
    return storageClient(this.config.endpoint || this.config.publicEndpoint, this.config.region, this.accessKeyId, this.secretAccessKey)
  }

  /** Browser-facing signatures: public endpoint first. */
  private publicClient(): S3Client {
    return storageClient(this.config.publicEndpoint || this.config.endpoint, this.config.region, this.accessKeyId, this.secretAccessKey)
  }

  async getBytes(key: string, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
    const response = await this.serverClient().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    if (!response.Body) throw new Error('S3_OBJECT_EMPTY')
    if (maxBytes !== Number.POSITIVE_INFINITY && (response.ContentLength ?? 0) > maxBytes) {
      ;(response.Body as { destroy?: () => void }).destroy?.()
      throw new StorageDriverError(STORAGE_OBJECT_TOO_LARGE)
    }
    return Buffer.from(await response.Body.transformToByteArray())
  }

  async getStream(key: string, options?: { signal?: AbortSignal }): Promise<StorageObjectStream> {
    const response = await this.serverClient().send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: options?.signal },
    )
    if (!response.Body) throw new Error('S3_OBJECT_EMPTY')
    return {
      body: response.Body as unknown as AsyncIterable<Uint8Array>,
      contentLength: response.ContentLength,
      contentType: response.ContentType,
    }
  }

  async putBytes(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.serverClient().send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType }))
  }

  /** Conditional PUT (If-None-Match: *). 409 and 412 mean the key exists; nothing else is retried or swallowed. */
  async putIfAbsent(key: string, bytes: Buffer, contentType: string): Promise<PutIfAbsentOutcome> {
    try {
      await this.serverClient().send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        IfNoneMatch: '*',
      }))
      return 'created'
    } catch (error) {
      if (isPreconditionFailure(error)) return 'exists'
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.serverClient().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async signRead(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.publicClient(), new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSeconds })
  }

  async signUpload(key: string, contentType: string, maxBytes: number, ttlSeconds: number): Promise<SignedUpload> {
    const result = await createPresignedPost(this.publicClient(), {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        { 'Content-Type': contentType },
      ],
      Fields: {
        'Content-Type': contentType,
      },
      Expires: ttlSeconds,
    })
    return { url: result.url, fields: result.fields }
  }

  /** HeadBucket plus a temporary Put/Get/Delete cycle. Every failure is STORAGE_TEST_FAILED. */
  async test(timeoutMs: number): Promise<void> {
    if (!this.config.bucket || !this.config.accessKeyId || !this.config.secretAccessKey) {
      throw new StorageDriverError(STORAGE_TEST_FAILED)
    }
    const client = this.serverClient()
    const key = `setup-tests/${randomUUID()}.txt`
    try {
      await withTimeout(client.send(new HeadBucketCommand({ Bucket: this.bucket })), timeoutMs)
      await withTimeout(client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: 'musecanvas-setup-test',
        ContentType: 'text/plain',
      })), timeoutMs)
      const got = await withTimeout(client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })), timeoutMs)
      try {
        await got.Body?.transformToByteArray()
      } catch {
        throw new StorageDriverError(STORAGE_TEST_FAILED)
      }
      await withTimeout(client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })), timeoutMs)
    } catch (error) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      } catch {
        // Best-effort cleanup of the temporary probe object.
      }
      if (error instanceof StorageDriverError) throw error
      throw new StorageDriverError(STORAGE_TEST_FAILED)
    }
  }
}
