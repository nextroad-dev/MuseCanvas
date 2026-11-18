export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>
}

export interface ImageEditUploadLimits {
  maxImageBytes: number
  uploadTtlSeconds: number
}

export interface ImageEditStoragePorts {
  db: () => SqlClient
  runTransaction: (fn: (client: SqlClient) => Promise<void>) => Promise<void>
  readObjectBytes: (objectKey: string) => Promise<Buffer>
  putObjectBytes: (objectKey: string, bytes: Buffer, contentType: string) => Promise<void>
  putReservedMask?: (objectKey: string, bytes: Buffer) => Promise<void>
  deleteObject: (objectKey: string) => Promise<void>
  uploadLimits: () => Promise<ImageEditUploadLimits>
}
