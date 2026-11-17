import type { NextResponse } from 'next/server'
import { RUNTIME_SETTINGS_DEFAULTS } from '@musecanvas/contracts'
import { db, transaction } from '@musecanvas/database'
import { limited } from '../../shared/redis'
import {
  deleteS3Object,
  getPrivateS3ObjectBytes,
  putPrivateS3ObjectBytes,
  putReservedImageMask,
} from '../../shared/services'
import { GENERATION_UPLOAD_TTL_SECONDS } from '../generation-uploads'
import { resolveRuntimeSettings } from '../settings/runtime'
import { createGenerationJob, type CreateGenerationJobCommand } from '../generations/create-job'

export { storeReadyInputImage, mirrorTableMissing, promoteKeyedInputRow, claimKeyedInputRow } from '@musecanvas/media-service/image-edit'
export type { SqlClient, ImageEditUploadLimits, ReadyInputWrite } from '@musecanvas/media-service/image-edit'
import type { ImageEditUploadLimits, ImageEditStoragePorts } from '@musecanvas/media-service'

export interface ImageEditPorts extends ImageEditStoragePorts {
  limited: (key: string, max: number, seconds: number) => Promise<boolean>
  createJob: (cmd: CreateGenerationJobCommand) => Promise<NextResponse>
}

/** Runtime settings first, canonical defaults last — the same resolution order the upload routes use. */
export async function resolveImageEditUploadLimits(): Promise<ImageEditUploadLimits> {
  try {
    const runtime = await resolveRuntimeSettings()
    return { maxImageBytes: runtime.maxImageBytes, uploadTtlSeconds: runtime.uploadTtlSeconds }
  } catch {
    return {
      maxImageBytes: RUNTIME_SETTINGS_DEFAULTS.maxImageBytes,
      uploadTtlSeconds: GENERATION_UPLOAD_TTL_SECONDS,
    }
  }
}

export const defaultImageEditPorts: ImageEditPorts = {
  db: () => db(),
  runTransaction: fn => transaction(async client => { await fn(client) }),
  limited,
  readObjectBytes: objectKey => getPrivateS3ObjectBytes(objectKey),
  putObjectBytes: (objectKey, bytes, contentType) => putPrivateS3ObjectBytes(objectKey, bytes, contentType),
  putReservedMask: putReservedImageMask,
  deleteObject: objectKey => deleteS3Object(objectKey),
  uploadLimits: resolveImageEditUploadLimits,
  createJob: cmd => createGenerationJob(cmd),
}
