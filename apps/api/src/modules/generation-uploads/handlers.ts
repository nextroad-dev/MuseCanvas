import { createHash, randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { db, transaction } from '../../../../../packages/database/src/index'
import { inspectInputImage } from '../../../../../packages/providers/src/index'
import type { Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import {
  createUploadPresignedPost,
  deleteS3Object,
  getPrivateS3ObjectBytes,
  signedAssetUrl,
} from '../../shared/services'
import { limited } from '../../shared/redis'
import {
  ALLOWED_MIME_TYPES,
  GENERATION_UPLOAD_SIGN_TTL_SECONDS,
  GENERATION_UPLOAD_TTL_SECONDS,
  GENERATION_UPLOAD_ID_PATTERN,
  MAX_ACTIVE_UPLOADS,
  MAX_UPLOAD_IMAGE_BYTES,
} from './constants'

async function rejectUpload(uploadId: string, objectKey: string): Promise<void> {
  try {
    await deleteS3Object(objectKey)
  } catch {
    // The maintenance sweep retries after the upload authorization expires.
  }

  await db().query(
    `UPDATE generation_input_images
     SET status='deleted', deleted_at=COALESCE(deleted_at, now()), updated_at=now()
     WHERE id=$1`,
    [uploadId]
  )
  try {
    await db().query(
      `UPDATE media_uploads
       SET status='deleted', deleted_at=COALESCE(deleted_at, now()), updated_at=now()
       WHERE id=$1`,
      [uploadId]
    )
  } catch {
    // media_uploads table may not exist on older databases.
  }
}

export async function createGenerationUpload(
  actor: Actor,
  input: unknown
): Promise<NextResponse> {
  if (await limited(`upload:${actor.id}`, 60, 60)) {
    return fail('RATE_LIMITED', '上传请求过于频繁，请稍后再试', 429)
  }

  if (!input || typeof input !== 'object') {
    return fail('INVALID_INPUT', '请求体格式无效')
  }

  const payload = input as Record<string, unknown>
  const mimeType = payload.mimeType
  if (typeof mimeType !== 'string' || !ALLOWED_MIME_TYPES[mimeType]) {
    return fail('INVALID_INPUT', '仅支持 PNG 或 JPEG 格式的图片')
  }

  const sizeBytes = Number(payload.sizeBytes)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_UPLOAD_IMAGE_BYTES) {
    return fail('INVALID_INPUT_IMAGE_SIZE', '图片大小超出限制')
  }

  const id = randomUUID()
  const ext = mimeType === 'image/png' ? 'png' : 'jpg'
  const objectKey = `inputs/${actor.id}/${id}.${ext}`
  const row = await transaction(async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor.id])
    const activeUploads = await client.query(
      `SELECT count(*)::int AS count
       FROM generation_input_images
       WHERE created_by=$1 AND status IN ('pending', 'ready') AND deleted_at IS NULL AND expires_at > now()`,
      [actor.id]
    )
    if (Number(activeUploads.rows[0]?.count || 0) >= MAX_ACTIVE_UPLOADS) return null

    const result = await client.query(
      `INSERT INTO generation_input_images(id, created_by, status, object_key, mime_type, size_bytes, expires_at)
       VALUES($1, $2, 'pending', $3, $4, $5, now() + ($6 * interval '1 second'))
       RETURNING id, expires_at`,
      [id, actor.id, objectKey, mimeType, sizeBytes, GENERATION_UPLOAD_TTL_SECONDS]
    )
    // Mirror into generic media_uploads so role-aware video/image inputs share one source.
    try {
      await client.query(
        `INSERT INTO media_uploads(id, created_by, media_kind, status, object_key, mime_type, size_bytes, expires_at)
         VALUES($1, $2, 'image', 'pending', $3, $4, $5, now() + ($6 * interval '1 second')) ON CONFLICT (id) DO NOTHING`,
        [id, actor.id, objectKey, mimeType, sizeBytes, GENERATION_UPLOAD_TTL_SECONDS]
      )
    } catch {
      // media_uploads table may not exist on older databases; legacy table remains source of truth.
    }
    return result.rows[0]
  })
  if (!row) {
    return fail('UPLOAD_QUOTA_EXCEEDED', '待处理参考图过多，请先移除已有图片', 429)
  }

  try {
    const presigned = await createUploadPresignedPost(
      objectKey,
      mimeType,
      sizeBytes,
      GENERATION_UPLOAD_SIGN_TTL_SECONDS
    )
    return ok(
      {
        id: row.id as string,
        uploadUrl: presigned.url,
        fields: presigned.fields,
        expiresAt: new Date(row.expires_at as string | number | Date).toISOString(),
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('createUploadPresignedPost error', error)
    await db().query('DELETE FROM generation_input_images WHERE id=$1', [id]).catch(() => {})
    return fail('UPLOAD_SIGN_FAILED', '生成上传凭证失败，请稍后重试', 503)
  }
}

export async function completeGenerationUpload(
  actor: Actor,
  uploadId: string
): Promise<NextResponse> {
  if (await limited(`upload-complete:${actor.id}`, 60, 60)) {
    return fail('RATE_LIMITED', '完成上传请求过于频繁，请稍后再试', 429)
  }
  if (!GENERATION_UPLOAD_ID_PATTERN.test(uploadId)) {
    return fail('INVALID_INPUT', '上传 ID 格式无效')
  }

  const existing = await db().query(
    'SELECT * FROM generation_input_images WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL',
    [uploadId, actor.id]
  )
  const upload = existing.rows[0]
  if (!upload) {
    return fail('NOT_FOUND', '上传记录不存在', 404)
  }

  if (upload.status === 'ready' || upload.status === 'attached') {
    return ok({
      id: upload.id as string,
      imageUrl: await signedAssetUrl(upload.object_key as string),
      mimeType: upload.mime_type as string,
      width: Number(upload.width || 0),
      height: Number(upload.height || 0),
      sizeBytes: Number(upload.size_bytes || 0),
    })
  }

  if (upload.status !== 'pending') {
    return fail('INVALID_STATE', '上传记录状态无效', 409)
  }

  if (new Date(upload.expires_at as string | number | Date).getTime() <= Date.now()) {
    await rejectUpload(upload.id as string, upload.object_key as string)
    return fail('UPLOAD_EXPIRED', '上传凭证已过期，请重新选择图片', 410)
  }

  const objectKey = upload.object_key as string
  let bytes: Buffer
  try {
    bytes = await getPrivateS3ObjectBytes(objectKey)
  } catch (error) {
    console.error('getPrivateS3ObjectBytes error', error)
    return fail('INPUT_IMAGE_UNAVAILABLE', '未找到已上传的文件，请先完成直传', 400)
  }

  const declaredSize = Number(upload.size_bytes)
  if (bytes.length !== declaredSize || bytes.length > MAX_UPLOAD_IMAGE_BYTES) {
    await rejectUpload(upload.id as string, objectKey)
    return fail('INVALID_INPUT_IMAGE_SIZE', '上传文件大小与声明不符', 400)
  }

  let inspected: { width: number; height: number; mimeType: string; sizeBytes: number }
  try {
    inspected = inspectInputImage(bytes)
  } catch (error) {
    await rejectUpload(upload.id as string, objectKey)
    const message = error instanceof Error ? error.message : 'INVALID_INPUT_IMAGE'
    const code = message === 'INVALID_INPUT_IMAGE_SIZE' ? 'INVALID_INPUT_IMAGE_SIZE' : 'INVALID_INPUT_IMAGE'
    return fail(code, '上传的图片无效或不受支持', 400)
  }

  if (inspected.mimeType !== upload.mime_type) {
    await rejectUpload(upload.id as string, objectKey)
    return fail('INVALID_INPUT_IMAGE', '上传文件类型与声明不符', 400)
  }

  const checksum = createHash('sha256').update(bytes).digest('hex')

  const updated = await db().query(
    `UPDATE generation_input_images
     SET status='ready', width=$1, height=$2, checksum=$3, updated_at=now()
     WHERE id=$4 AND created_by=$5 AND status='pending'
     RETURNING *`,
    [inspected.width, inspected.height, checksum, upload.id, actor.id]
  )
  try {
    await db().query(
      `UPDATE media_uploads
       SET status='ready', width=$1, height=$2, checksum=$3, updated_at=now()
       WHERE id=$4 AND created_by=$5 AND status='pending'`,
      [inspected.width, inspected.height, checksum, upload.id, actor.id]
    )
  } catch {
    // media_uploads table may not exist on older databases.
  }

  const finalRow = updated.rows[0] || (
    await db().query(
      'SELECT * FROM generation_input_images WHERE id=$1 AND created_by=$2',
      [upload.id, actor.id]
    )
  ).rows[0]
  if (
    !finalRow ||
    finalRow.deleted_at !== null ||
    !['ready', 'attached'].includes(finalRow.status as string)
  ) {
    return fail('INVALID_STATE', '上传记录状态已变更，请重新选择图片', 409)
  }
  return ok({
    id: finalRow.id as string,
    imageUrl: await signedAssetUrl(finalRow.object_key as string),
    mimeType: finalRow.mime_type as string,
    width: Number(finalRow.width || 0),
    height: Number(finalRow.height || 0),
    sizeBytes: Number(finalRow.size_bytes || 0),
  })
}

export async function deleteGenerationUpload(
  actor: Actor,
  uploadId: string
): Promise<NextResponse> {
  if (await limited(`upload-delete:${actor.id}`, 60, 60)) {
    return fail('RATE_LIMITED', '请求过于频繁，请稍后再试', 429)
  }

  if (!GENERATION_UPLOAD_ID_PATTERN.test(uploadId)) {
    return fail('INVALID_INPUT', '上传 ID 格式无效')
  }

  const deleted = await db().query(
    `UPDATE generation_input_images
     SET status='deleted', deleted_at=now(), updated_at=now()
     WHERE id=$1 AND created_by=$2 AND status IN ('pending','ready') AND deleted_at IS NULL
     RETURNING id, object_key`,
    [uploadId, actor.id]
  )
  const upload = deleted.rows[0]
  if (!upload) {
    const state = await db().query(
      'SELECT status FROM generation_input_images WHERE id=$1 AND created_by=$2',
      [uploadId, actor.id]
    )
    if (state.rows[0]?.status === 'attached') {
      return fail('IMAGE_ATTACHED', '图片已关联到生成任务，无法删除', 409)
    }
    return ok({ deleted: true })
  }
  try {
    await db().query(
      `UPDATE media_uploads
       SET status='deleted', deleted_at=now(), updated_at=now()
       WHERE id=$1 AND created_by=$2 AND status IN ('pending','ready') AND deleted_at IS NULL`,
      [uploadId, actor.id]
    )
  } catch {
    // media_uploads table may not exist on older databases.
  }
  try {
    await deleteS3Object(upload.object_key as string)
  } catch {
    // The maintenance sweep retries after the upload authorization expires.
  }

  return ok({ deleted: true })
}
