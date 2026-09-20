'use client'

import { api } from '@/shared/services/api'
import { useGenerateUiStore } from '@/shared/stores/generate-ui-store'
import { planRolePositions, resolveImageInputPlan } from '@/shared/lib/generation-params'
import type { ImageInputPlanModel } from '@/shared/lib/generation-params'
import { RUNTIME_SETTINGS_DEFAULTS, assetPlaybackUrl, assetPreviewUrl, isVideoAsset } from '@/shared/types'
import type { Asset, ModelConfig, StagedReferenceImage } from '@/shared/types'

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

/** Staged gallery previews already re-signed, so a permanently dead object cannot
 *  turn a broken `<img>` into an error→sign→error request loop. */
const previewRefreshed = new Set<string>()

const store = () => useGenerateUiStore.getState()

/** Decimal units: the server compares against 10_000_000 / 20_000_000 bytes. */
export function formatSize(bytes: number): string {
  const kilobytes = Math.round(bytes / 1000)
  if (kilobytes < 1000) return `${kilobytes}KB`
  return `${Number((bytes / 1_000_000).toFixed(1))}MB`
}

export function resolveMaxInputs(model?: Pick<ModelConfig, 'inputSlots' | 'maxInputImages'> | null): number {
  // The plan owns the rules: image-accepting slots only, `source_video` excluded,
  // and video models lose `reference_image` (frames are positional there).
  return resolveImageInputPlan(model).capacity
}

/** Re-derive staged input roles after a model or tab switch.
 *
 *  It lives here rather than in the store because dropping a staged item is only
 *  safe through `removeReferenceImage` (abort the in-flight XHR, delete the remote
 *  object, revoke the preview blob) — nothing outside this module owns those handles.
 *
 *  Rule: reconcile NEVER deletes an upload. Overflow past `plan.capacity` can only
 *  appear when capacity shrank under already-staged files (image tab holds 4, video
 *  tab holds 2), and silently destroying user uploads on a tab switch is worse than
 *  an invalid selection. Overflow items keep their previous role and
 *  `inputPlanViolations` blocks submission with an explicit message until the user
 *  removes them; switching back restores their roles untouched. `addReferenceFiles`
 *  already refuses to stage past capacity, so this is the only path that can reach it.
 *
 *  Roles for the first `plan.capacity` items are reassigned by position over the
 *  flattened slot list, and the store is left untouched when nothing would change.
 */
export async function reconcileStagedRoles(model?: ImageInputPlanModel | null): Promise<void> {
  const plan = resolveImageInputPlan(model)
  const staged = store().stagedImages
  if (staged.length === 0) return

  const positions = planRolePositions(plan)
  const assignable = Math.min(staged.length, positions.length)
  const pending: Array<{ localId: string; role: StagedReferenceImage['role'] }> = []
  for (let index = 0; index < assignable; index += 1) {
    const role = positions[index] as StagedReferenceImage['role']
    if (staged[index].role !== role) pending.push({ localId: staged[index].localId, role })
  }
  if (pending.length === 0) return

  for (const change of pending) patch(change.localId, { role: change.role })
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
      source: 'upload',
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

/**
 * Can this gallery image feed a generation? The worker only decodes PNG and JPEG
 * magic bytes (`inspectImageBytes`), so any other stored artifact — a WebP, a video
 * — would fail the job minutes after submit. Checking it here keeps the picker honest
 * instead of offering tiles that cannot be used.
 */
export function isReferenceEligibleAsset(asset: Pick<Asset, 'mediaKind' | 'mimeType' | 'url' | 'imageUrl'>): boolean {
  if (isVideoAsset(asset)) return false
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes((asset.mimeType || '').toLowerCase())
}

/** Geometry gate for a gallery pick, using the dimensions already stored on the row.
 *
 *  Rows written before those columns existed carry nothing to check; the server still
 *  re-validates against the real bytes, so a missing dimension must not block a pick.
 *  Same thresholds as `checkImageDimensions` applies to a local file. */
function galleryGeometryError(asset: Pick<Asset, 'width' | 'height'>): string | null {
  const { minDimension, maxDimension, maxAspectRatio } = UPLOAD_LIMITS
  const width = asset.width
  const height = asset.height
  if (!width || !height) return null
  if (width < minDimension || width > maxDimension || height < minDimension || height > maxDimension) {
    return `分辨率须在 ${minDimension}~${maxDimension} 像素之间（当前 ${width}×${height}）`
  }
  const ratio = Math.max(width / height, height / width)
  if (ratio > maxAspectRatio) {
    return `宽高比不能超过 ${maxAspectRatio}:1（当前 ${ratio.toFixed(1)}:1）`
  }
  return null
}

/**
 * Stage an existing gallery image as an input reference.
 *
 * The counterpart to `addReferenceFiles`, and deliberately not a download-then-upload:
 * the bytes are already in storage under this user's account, so the pick goes
 * straight to `ready` and the request carries `assetId`. No upload row, no second
 * object, no progress to report — and removing it later must never delete the asset.
 *
 * @returns whether the image was added, so the picker can close only on success.
 */
export async function addGalleryImage(
  asset: Asset,
  model: Pick<ModelConfig, 'inputSlots' | 'maxInputImages'> | null | undefined,
): Promise<boolean> {
  setInlineError(null)

  const maxInputs = resolveMaxInputs(model)
  if (maxInputs === 0) {
    setInlineError('当前模型不支持参考图，请切换到支持图生图的模型')
    return false
  }
  const staged = store().stagedImages
  if (staged.length >= maxInputs) {
    setInlineError(`最多支持添加 ${maxInputs} 张参考图`)
    return false
  }
  if (staged.some((image) => image.assetId === asset.id)) {
    setInlineError('这张图库图片已经在输入列表里了')
    return false
  }
  if (!isReferenceEligibleAsset(asset)) {
    setInlineError('图库中仅 PNG 或 JPEG 图片可作为参考图')
    return false
  }
  if (asset.sizeBytes > UPLOAD_LIMITS.maxImageBytes) {
    setInlineError(
      `该图片超过单张 ${formatSize(UPLOAD_LIMITS.maxImageBytes)} 限制（当前 ${formatSize(asset.sizeBytes)}）`,
    )
    return false
  }
  if (referenceImagesTotalBytes() + asset.sizeBytes > UPLOAD_LIMITS.maxTotalBytes) {
    setInlineError(`参考图总大小不能超过 ${formatSize(UPLOAD_LIMITS.maxTotalBytes)}`)
    return false
  }
  const geometry = galleryGeometryError(asset)
  if (geometry) {
    setInlineError(geometry)
    return false
  }

  store().addStagedImage({
    // The asset id doubles as the local id, which is what makes re-picking the same
    // image a no-op instead of a duplicate slot.
    localId: `gallery-${asset.id}`,
    source: 'gallery',
    assetId: asset.id,
    previewUrl: assetPreviewUrl(asset),
    status: 'ready',
    progress: 100,
    imageUrl: assetPlaybackUrl(asset),
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
  })
  // Same role re-derivation an upload gets: position, not provenance, decides
  // 首帧 / 尾帧, so a gallery pick can occupy either slot.
  await reconcileStagedRoles(model)
  return true
}

/**
 * Swap an expired gallery preview for a freshly signed URL.
 *
 * Only `source: 'gallery'` needs this — a blob URL lives as long as we keep it. The
 * reference itself is unaffected: submit carries `assetId`, and the server re-signs
 * the bytes it reads, so a dead preview is cosmetic, never a failed generation.
 */
export async function refreshGalleryPreview(localId: string): Promise<void> {
  const staged = store().stagedImages.find((image) => image.localId === localId)
  if (!staged || staged.source !== 'gallery' || !staged.assetId) return
  if (previewRefreshed.has(localId)) return
  previewRefreshed.add(localId)

  const res = await api.getAssetDownloadUrl(staged.assetId)
  const url = res.success ? res.data?.url : undefined
  if (!url || !isStaged(localId)) return
  patch(localId, { previewUrl: url, imageUrl: url })
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
  previewRefreshed.delete(localId)
  // Only an upload owns anything: an upload row and its object are ours to delete.
  // A gallery pick is a reference to someone's existing work — dropping the slot must
  // never reach into the library.
  if (staged.source === 'upload') {
    if (staged.uploadId) await api.deleteGenerationUpload(staged.uploadId)
    URL.revokeObjectURL(staged.previewUrl)
  }
  refreshInlineError()
}

export async function retryReferenceUpload(localId: string): Promise<void> {
  const staged = store().stagedImages.find((image) => image.localId === localId)
  if (!staged) return
  // A gallery pick has no bytes to re-send; it is ready the moment it is added.
  if (!staged.file) return

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
    previewRefreshed.delete(image.localId)
    if (deleteRemote && image.uploadId) await api.deleteGenerationUpload(image.uploadId)
    // Blob URLs are ours to reclaim; a gallery URL is a remote signed address and only
    // the upload branch may call revokeObjectURL on it.
    if (image.source === 'upload') URL.revokeObjectURL(image.previewUrl)
  }
}
