'use client'

import { api } from '@/shared/services/api'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import { resolveInputSlots } from '@/shared/lib/generation-params'
import { RUNTIME_SETTINGS_DEFAULTS } from '@/shared/types'
import type { ModelConfig, StagedReferenceImage } from '@/shared/types'

export const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const

export const UPLOAD_LIMITS = {
  maxImageBytes: RUNTIME_SETTINGS_DEFAULTS.maxImageBytes,
  maxTotalBytes: RUNTIME_SETTINGS_DEFAULTS.maxTotalBytes,
  minDimension: 32,
  maxDimension: 6000,
  maxAspectRatio: 16,
} as const

/** Live XHR handles stay outside the store: patching them would rebuild the
 *  staged array on every progress tick and keep unparsable objects in state. */
const inflight = new Map<string, XMLHttpRequest>()

const store = () => useGenerateUiStore.getState()

/** Decimal units: the server compares against 10_000_000 / 20_000_000 bytes. */
export function formatSize(bytes: number): string {
  const kilobytes = Math.round(bytes / 1000)
  if (kilobytes < 1000) return `${kilobytes}KB`
  return `${Number((bytes / 1_000_000).toFixed(1))}MB`
}

export function resolveMaxInputs(model?: Pick<ModelConfig, 'inputSlots' | 'maxInputImages'> | null): number {
  // Only image-accepting slots count: a video model's `source_video` slot must not
  // inflate the reference-image budget.
  const imageSlots = resolveInputSlots(model).filter(
    (slot) => slot.allowedMediaKinds.length === 0 || slot.allowedMediaKinds.includes('image'),
  )
  const capacity = imageSlots.reduce((sum, slot) => sum + Math.max(0, slot.maxCount), 0)
  if (capacity <= 0) return 0
  return Math.min(capacity, RUNTIME_SETTINGS_DEFAULTS.maxInputs)
}

function referenceImagesTotalBytes(): number {
  return store().stagedImages.reduce((sum, image) => sum + image.sizeBytes, 0)
}

function patch(localId: string, changes: Partial<StagedReferenceImage>): void {
  store().updateStagedImage(localId, changes)
}

function isStaged(localId: string): boolean {
  return store().stagedImages.some((image) => image.localId === localId)
}

function setInlineError(message: string | null): void {
  store().setInlineUploadError(message)
}

/** Surface the first remaining failure so clearing one error doesn't hide another. */
function refreshInlineError(): void {
  setInlineError(store().stagedImages.find((image) => image.status === 'error')?.error ?? null)
}

function failUpload(localId: string, message: string): void {
  patch(localId, { status: 'error', error: message })
  setInlineError(message)
}

function checkImageDimensions(
  file: File,
): Promise<{ width: number; height: number; error?: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      const width = image.naturalWidth
      const height = image.naturalHeight
      const { minDimension, maxDimension, maxAspectRatio } = UPLOAD_LIMITS
      if (width < minDimension || width > maxDimension || height < minDimension || height > maxDimension) {
        resolve({
          width,
          height,
          error: `分辨率须在 ${minDimension}~${maxDimension} 像素之间（当前 ${width}×${height}）`,
        })
        return
      }
      const ratio = Math.max(width / height, height / width)
      if (ratio > maxAspectRatio) {
        resolve({
          width,
          height,
          error: `宽高比不能超过 ${maxAspectRatio}:1（当前 ${ratio.toFixed(1)}:1）`,
        })
        return
      }
      resolve({ width, height })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      resolve({ width: 0, height: 0, error: '无法解析该图片文件' })
    }
    image.src = url
  })
}

export async function addReferenceFiles(
  fileList: File[] | FileList,
  model: Pick<ModelConfig, 'inputSlots' | 'maxInputImages'> | null | undefined,
): Promise<void> {
  const files = Array.from(fileList)
  setInlineError(null)
  if (files.length === 0) return

  const maxInputs = resolveMaxInputs(model)
  if (maxInputs === 0) {
    setInlineError('当前模型不支持参考图，请切换到支持图生图的模型')
    return
  }

  for (const file of files) {
    const current = store().stagedImages
    if (current.length >= maxInputs) {
      setInlineError(`最多支持添加 ${maxInputs} 张参考图`)
      break
    }
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      setInlineError(`「${file.name}」格式不支持，仅支持 PNG 或 JPEG 图片`)
      continue
    }
    if (file.size > UPLOAD_LIMITS.maxImageBytes) {
      setInlineError(
        `「${file.name}」超过单张 ${formatSize(UPLOAD_LIMITS.maxImageBytes)} 限制（当前 ${formatSize(file.size)}）`,
      )
      continue
    }
    if (referenceImagesTotalBytes() + file.size > UPLOAD_LIMITS.maxTotalBytes) {
      setInlineError(`参考图总大小不能超过 ${formatSize(UPLOAD_LIMITS.maxTotalBytes)}`)
      break
    }

    const dimensions = await checkImageDimensions(file)
    if (dimensions.error) {
      setInlineError(`「${file.name}」${dimensions.error}`)
      continue
    }

    // Decoding is async, so re-check the counters a concurrent pick may have moved.
    const afterDecode = store().stagedImages
    if (
      afterDecode.length >= maxInputs ||
      afterDecode.reduce((sum, image) => sum + image.sizeBytes, 0) + file.size >
        UPLOAD_LIMITS.maxTotalBytes
    ) {
      setInlineError(
        afterDecode.length >= maxInputs
          ? `最多支持添加 ${maxInputs} 张参考图`
          : `参考图总大小不能超过 ${formatSize(UPLOAD_LIMITS.maxTotalBytes)}`,
      )
      break
    }

    const localId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    store().addStagedImage({
      localId,
      file,
      previewUrl: URL.createObjectURL(file),
      status: 'pending',
      progress: 0,
      mimeType: file.type,
      sizeBytes: file.size,
      width: dimensions.width,
      height: dimensions.height,
    })
    // Deliberately not awaited: each file uploads independently and keeps its own progress.
    void startUpload(localId, file, file.type, file.size)
  }
}

async function startUpload(
  localId: string,
  file: File,
  mimeType: string,
  sizeBytes: number,
): Promise<void> {
  patch(localId, { status: 'uploading', progress: 0, error: undefined })

  const presign = await api.createGenerationUpload({ mimeType, sizeBytes })
  if (!isStaged(localId)) {
    if (presign.success && presign.data) await api.deleteGenerationUpload(presign.data.id)
    return
  }
  if (!presign.success || !presign.data) {
    failUpload(localId, presign.error?.message || '获取上传地址失败')
    return
  }

  const { id: uploadId, uploadUrl, fields } = presign.data
  patch(localId, { uploadId })

  const xhr = new XMLHttpRequest()
  inflight.set(localId, xhr)

  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return
    // Hold at 99% until the server has verified the stored bytes.
    patch(localId, { progress: Math.min(99, Math.round((event.loaded / event.total) * 100)) })
  }

  xhr.onload = async () => {
    inflight.delete(localId)
    if (!isStaged(localId)) return
    if (xhr.status < 200 || xhr.status >= 300) {
      failUpload(localId, `上传至存储服务失败（HTTP ${xhr.status}）`)
      return
    }
    patch(localId, { progress: 100, status: 'processing' })
    const completed = await api.completeGenerationUpload(uploadId)
    if (!isStaged(localId)) return
    if (!completed.success || !completed.data) {
      failUpload(localId, completed.error?.message || '上传确认失败')
      return
    }
    patch(localId, {
      status: 'ready',
      imageUrl: completed.data.imageUrl,
      width: completed.data.width,
      height: completed.data.height,
      error: undefined,
    })
    refreshInlineError()
  }

  xhr.onerror = () => {
    inflight.delete(localId)
    if (!isStaged(localId)) return
    // A multipart POST is a *simple* request: no preflight, so the bytes can already
    // be stored while the browser reports status 0 and refuses to read the response.
    // Never complete on this path — the server must only inspect bytes it accepted.
    failUpload(localId, '无法读取存储服务响应，请检查跨域允许来源（MINIO_API_CORS_ALLOW_ORIGIN）或网络连接')
  }

  xhr.onabort = () => {
    inflight.delete(localId)
  }

  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  // S3 presigned POST requires the file to be the final part.
  form.append('file', file)
  xhr.open('POST', uploadUrl)
  xhr.send(form)
}

export async function removeReferenceImage(localId: string): Promise<void> {
  const staged = store().stagedImages.find((image) => image.localId === localId)
  if (!staged) return

  store().removeStagedImage(localId)
  inflight.get(localId)?.abort()
  inflight.delete(localId)
  if (staged.uploadId) await api.deleteGenerationUpload(staged.uploadId)
  URL.revokeObjectURL(staged.previewUrl)
  refreshInlineError()
}

export async function retryReferenceUpload(localId: string): Promise<void> {
  const staged = store().stagedImages.find((image) => image.localId === localId)
  if (!staged) return

  if (staged.uploadId) await api.deleteGenerationUpload(staged.uploadId)
  patch(localId, { uploadId: undefined })
  if (!isStaged(localId)) return
  await startUpload(localId, staged.file, staged.mimeType, staged.sizeBytes)
}

export function reorderReferenceImages(from: number, to: number): void {
  store().setStagedImages((previous) => {
    if (from === to || from < 0 || to < 0 || from >= previous.length || to >= previous.length) {
      return previous
    }
    const next = [...previous]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
  })
}

/** `deleteRemote: false` after a successful submit: those uploads are now
 *  `attached` to the job and the API refuses to delete them. */
export async function clearReferenceImages(options: { deleteRemote?: boolean } = {}): Promise<void> {
  const { deleteRemote = true } = options
  const images = store().stagedImages
  store().clearStagedImages()
  setInlineError(null)

  for (const image of images) {
    inflight.get(image.localId)?.abort()
    inflight.delete(image.localId)
    if (deleteRemote && image.uploadId) await api.deleteGenerationUpload(image.uploadId)
    URL.revokeObjectURL(image.previewUrl)
  }
}
