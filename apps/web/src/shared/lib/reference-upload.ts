'use client'

// 参考图直传与校验。上传链路：POST /generation-uploads 拿预签名 →
// 浏览器直传对象存储（S3 POST / 本地存储签名口）→ POST /complete 让服务端验字节。
// 只有 upload 拥有远端行；gallery 引用已有 asset，移除槽位绝不碰图库。

import { clientApi } from '@/shared/services/client-api'
import { formatBytes } from '@/shared/lib/format'
import { buildGenerationInputs } from '@/shared/lib/generation-params'
import type {
  AssetDto,
  GenerationJobInputDto,
  StagedReferenceImage,
  UploadCompleteDto,
} from '@/shared/types'
import { assetPlaybackUrl, isVideoAsset } from '@/shared/types'

export const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const

/** 与后端 RUNTIME_SETTINGS_DEFAULTS 对齐；服务端始终是最终权威。 */
export const UPLOAD_LIMITS = {
  maxImageBytes: 10_000_000,
  maxTotalBytes: 20_000_000,
  minDimension: 32,
  maxDimension: 6000,
  maxAspectRatio: 16,
} as const

/** @deprecated 使用 `formatBytes`（保留旧名给既有调用点）。 */
export const formatSize = formatBytes

/** 图库图片能否作参考图：worker 只解 PNG/JPEG 魔数，别给无法使用的缩略图。 */
export function isReferenceEligibleAsset(
  asset: Pick<AssetDto, 'mediaKind' | 'mimeType' | 'url' | 'imageUrl'>,
): boolean {
  if (isVideoAsset(asset)) return false
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes((asset.mimeType || '').toLowerCase())
}

/** 尺寸/宽高比门槛；合法返回 null。 */
export function validateImageDimensions(width: number, height: number): string | null {
  const { minDimension, maxDimension, maxAspectRatio } = UPLOAD_LIMITS
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '无法解析该图片的尺寸'
  }
  if (width < minDimension || width > maxDimension || height < minDimension || height > maxDimension) {
    return `分辨率须在 ${minDimension}~${maxDimension} 像素之间（当前 ${width}×${height}）`
  }
  const ratio = Math.max(width / height, height / width)
  if (ratio > maxAspectRatio) {
    return `宽高比不能超过 ${maxAspectRatio}:1（当前 ${ratio.toFixed(1)}:1）`
  }
  return null
}

/** 解码本地文件尺寸（仅浏览器）。 */
export function readImageDimensions(
  file: File,
): Promise<{ width: number; height: number; error?: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      const width = image.naturalWidth
      const height = image.naturalHeight
      const error = validateImageDimensions(width, height)
      resolve(error ? { width, height, error } : { width, height })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      resolve({ width: 0, height: 0, error: '无法解析该图片文件' })
    }
    image.src = url
  })
}

export interface ReferenceSelectionLimits {
  /** 当前已暂存数量。 */
  selectedCount: number
  /** 当前已暂存总字节。 */
  totalBytes: number
  /** 当前模型可接受的参考图上限。 */
  maxInputs: number
}

export interface ReferenceSelectionResult {
  accepted: File[]
  errors: string[]
}

/** 选文件时的同步预检：格式/单张大小/总量/数量上限。 */
export function validateReferenceSelection(
  files: File[],
  limits: ReferenceSelectionLimits,
): ReferenceSelectionResult {
  const accepted: File[] = []
  const errors: string[] = []
  if (limits.maxInputs <= 0) {
    return { accepted, errors: ['当前模型不支持参考图，请切换到支持图生图的模型'] }
  }
  let count = limits.selectedCount
  let total = limits.totalBytes
  for (const file of files) {
    if (count >= limits.maxInputs) {
      errors.push(`最多支持添加 ${limits.maxInputs} 张参考图`)
      break
    }
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      errors.push(`「${file.name}」格式不支持，仅支持 PNG 或 JPEG 图片`)
      continue
    }
    if (file.size > UPLOAD_LIMITS.maxImageBytes) {
      errors.push(
        `「${file.name}」超过单张 ${formatBytes(UPLOAD_LIMITS.maxImageBytes)} 限制（当前 ${formatBytes(file.size)}）`,
      )
      continue
    }
    if (total + file.size > UPLOAD_LIMITS.maxTotalBytes) {
      errors.push(`参考图总大小不能超过 ${formatBytes(UPLOAD_LIMITS.maxTotalBytes)}`)
      break
    }
    accepted.push(file)
    count += 1
    total += file.size
  }
  return { accepted, errors }
}

/** 一张本地文件走完「预签名 → 直传 → 服务端确认」并返回完成信息。 */
export async function uploadReferenceFile(
  file: File,
  options: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
): Promise<UploadCompleteDto> {
  const presign = await clientApi.generationUploads.create({
    mimeType: file.type,
    sizeBytes: file.size,
  })
  if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
  await clientApi.media.upload(presign, file, options)
  options.onProgress?.(100)
  return clientApi.generationUploads.complete(presign.id)
}

/** 删除尚未附加到任务的上传行与对象；已 attached 的会由服务端拒绝。 */
export async function deleteReferenceUpload(uploadId: string): Promise<void> {
  await clientApi.generationUploads.remove(uploadId)
}

/** 图库签名 URL 过期后的恢复路径；失败返回 null，由调用方提示重新选择。 */
export async function refreshGalleryAssetUrl(assetId: string): Promise<string | null> {
  try {
    const result = await clientApi.library.download(assetId)
    return result.url || result.downloadUrl || null
  } catch {
    return null
  }
}

/** 图库资产预览地址（原图；网格优先用 worker 缩略图）。 */
export function galleryReferencePreview(asset: AssetDto): string {
  return assetPlaybackUrl(asset)
}

/** 暂存项 → 统一 inputs[]（仅 ready 且带 uploadId/assetId 的项）。 */
export function stagedToGenerationInputs(
  staged: ReadonlyArray<Pick<StagedReferenceImage, 'uploadId' | 'assetId' | 'status' | 'role'>>,
) {
  return buildGenerationInputs(
    staged.map((item) => ({
      uploadId: item.uploadId,
      assetId: item.assetId,
      role: item.role,
      status: item.status,
    })),
  )
}

/** job DTO 的 inputs 投影 → 生成请求可复用的引用（「用同样参数再画」）。 */
export function jobInputsToGenerationInputs(
  inputs: ReadonlyArray<Pick<GenerationJobInputDto, 'uploadId' | 'assetId' | 'role' | 'position'>>,
) {
  return buildGenerationInputs(inputs)
}
