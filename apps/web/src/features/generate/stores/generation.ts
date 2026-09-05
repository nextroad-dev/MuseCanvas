import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type {
  GenerationJob,
  ModelConfig,
  Quality,
  StagedReferenceImage,
  StagedInputRole,
  PresignedUploadResponse,
  UploadCompleteResponse,
} from '@/shared/types'
import { isVideoModel } from '@/shared/types'
import {
  availableAspectRatios,
  availableDurations,
  availableResolutions,
  buildGenerationInputs,
  buildImageParameters,
  buildVideoParameters,
  estimateModelCredits,
  firstLastFrameViolations,
  maxInputCount,
  normalizeVideoControls,
  resolveInputSlots,
} from '@/features/generate/lib/generation-params'
import { api } from '@/shared/services/api'
import { toast } from '@/shared/composables/useToast'
import { useLibraryStore } from '@/features/library/stores/library'
import { useAccountStore } from '@/features/account/stores/account'
// Absolute defense ceilings (setup-allowed maxima). Server runtime settings
// are authoritative: this preflight only rejects inputs no valid runtime
// could accept, so raised/lowered DB limits are never contradicted here.
export const MAX_INPUT_IMAGES = 32
export const MAX_UPLOAD_IMAGE_BYTES = 100_000_000 // 100MB absolute ceiling
export const MAX_UPLOAD_TOTAL_BYTES = 200_000_000 // 200MB absolute ceiling
export const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg']
export const MIN_IMAGE_DIMENSION = 32
export const MAX_IMAGE_DIMENSION = 6000
export const MAX_ASPECT_RATIO = 16

function formatLimitMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

export const useGenerationStore = defineStore('generation', () => {
  const models = ref<ModelConfig[]>([])
  const jobs = ref<GenerationJob[]>([])
  const selectedJobId = ref<string | null>(null)
  const loading = ref(false)

  // Form state
  const prompt = ref('')
  const selectedModelId = ref('')
  const selectedSize = ref('1024x1024')
  const selectedQuality = ref<Quality>('auto')
  const count = ref(1)
  const selectedModel = computed(() => models.value.find((model) => model.id === selectedModelId.value))
  const selectedJob = computed(() => jobs.value.find((job) => job.id === selectedJobId.value))
  const availableSizes = computed(() => selectedModel.value?.sizes || [])
  const availableQualities = computed<Quality[]>(() => selectedModel.value?.qualityOptions || ['auto'])
  const maxCount = computed(() => selectedModel.value?.maxCount || 1)
  const stagedImages = ref<StagedReferenceImage[]>([])
  const inlineUploadError = ref<string | null>(null)

  // Video form state (only applies to video models; preserved across switches)
  const videoDuration = ref(4)
  const videoAspectRatio = ref('16:9')
  const videoResolution = ref('720p')
  const videoAudio = ref(true)


  const isVideo = computed(() => isVideoModel(selectedModel.value))
  const inputSlots = computed(() => resolveInputSlots(selectedModel.value))
  const modelMaxInputImages = computed(() => {
    const fromSlots = maxInputCount(selectedModel.value)
    if (fromSlots > 0) return Math.min(fromSlots, MAX_INPUT_IMAGES)
    return Math.min(selectedModel.value?.maxInputImages ?? 0, MAX_INPUT_IMAGES)
  })
  const isModelSupportingImages = computed(() => modelMaxInputImages.value > 0)
  const stagedImagesCount = computed(() => stagedImages.value.length)
  const stagedImagesTotalBytes = computed(() =>
    stagedImages.value.reduce((acc, img) => acc + img.sizeBytes, 0)
  )

  // Dynamic video controls derived from the selected model's capability descriptors.
  const videoDurations = computed(() => availableDurations(selectedModel.value))
  const videoAspectRatios = computed(() => availableAspectRatios(selectedModel.value))
  const videoResolutions = computed(() => availableResolutions(selectedModel.value))
  const normalizedVideo = computed(() => normalizeVideoControls(selectedModel.value, {
    durationSeconds: videoDuration.value,
    aspectRatio: videoAspectRatio.value,
    resolution: videoResolution.value,
    audio: videoAudio.value,
    count: count.value,
  }))

  const accountStore = useAccountStore()
  const isBillingEnabled = computed(() => accountStore.billingSettings?.enabled ?? false)
  const isBillingReady = computed(() => {
    if (!accountStore.billingSettingsLoaded) return false
    if (accountStore.billingSettings?.enabled) {
      return accountStore.creditsLoaded
    }
    return true
  })
  const estimatedCredits = computed(() => {
    const model = selectedModel.value
    if (!model) return 0
    const optCredits = (
      isBillingEnabled.value &&
      accountStore.billingSettings?.promptOptimizationEnabled
    ) ? accountStore.billingSettings.promptOptimizationCredits : 0
    if (isVideo.value) {
      return estimateModelCredits(model, {
        count: count.value,
        durationSeconds: normalizedVideo.value.durationSeconds,
        optimizationCredits: optCredits,
      })
    }
    return estimateModelCredits(model, { count: count.value, optimizationCredits: optCredits })
  })
  const hasSufficientCredits = computed(() => {
    if (!accountStore.billingSettingsLoaded) return false
    if (!isBillingEnabled.value) return true
    if (!accountStore.creditsLoaded || !accountStore.creditBalance) return false
    return accountStore.creditBalance.availableCredits >= estimatedCredits.value
  })
  const stagedImagesUploading = computed(() =>
    stagedImages.value.some(
      (img) => img.status === 'uploading' || img.status === 'processing' || img.status === 'pending'
    )
  )
  const stagedImagesHasError = computed(() =>
    stagedImages.value.some((img) => img.status === 'error')
  )

  const stagedImagesValidationError = computed<string | null>(() => {
    if (stagedImages.value.length === 0) return null
    if (!isModelSupportingImages.value) {
      return '当前模型不支持参考图，请切换模型或移除参考图'
    }
    if (stagedImages.value.length > modelMaxInputImages.value) {
      return `参考图数量超出当前模型上限（最多 ${modelMaxInputImages.value} 张）`
    }
    if (stagedImagesTotalBytes.value > MAX_UPLOAD_TOTAL_BYTES) {
      return `参考图总大小不能超过 ${formatLimitMb(MAX_UPLOAD_TOTAL_BYTES)}`
    }
    if (stagedImagesUploading.value) {
      return '参考图正在上传，请等待完成'
    }
    if (stagedImagesHasError.value) {
      return '存在上传失败的参考图，请重试或移除'
    }
    const frameError = firstLastFrameViolations(stagedImages.value)
    if (frameError.length > 0) return frameError[0]
    return null
  })

  const canSubmitWithImages = computed(() => stagedImagesValidationError.value === null)

  function refreshInlineUploadError() {
    inlineUploadError.value = stagedImages.value.find((image) => image.status === 'error')?.error || null
  }

  function checkImageDimensions(file: File): Promise<{ width: number; height: number; valid: boolean; error?: string }> {
    const { promise, resolve } = Promise.withResolvers<{ width: number; height: number; valid: boolean; error?: string }>()
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (w < MIN_IMAGE_DIMENSION || w > MAX_IMAGE_DIMENSION || h < MIN_IMAGE_DIMENSION || h > MAX_IMAGE_DIMENSION) {
        resolve({ width: w, height: h, valid: false, error: `图片分辨率须在 32~6000 像素之间 (当前: ${w}x${h})` })
        return
      }
      const ratio = Math.max(w / h, h / w)
      if (ratio > MAX_ASPECT_RATIO) {
        resolve({ width: w, height: h, valid: false, error: `图片宽高比不能超过 16:1 (当前: ${(w / h).toFixed(1)}:1)` })
        return
      }
      resolve({ width: w, height: h, valid: true })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve({ width: 0, height: 0, valid: false, error: '无法解析图片文件' })
    }
    img.src = url
    return promise
  }

  async function addStagedFiles(fileList: File[] | FileList) {
    inlineUploadError.value = null
    const files = Array.from(fileList)
    if (files.length === 0) return

    const maxAllowed = Math.min(modelMaxInputImages.value > 0 ? modelMaxInputImages.value : MAX_INPUT_IMAGES, MAX_INPUT_IMAGES)

    for (const file of files) {
      if (stagedImages.value.length >= maxAllowed) {
        const err = `最多支持添加 ${maxAllowed} 张参考图`
        inlineUploadError.value = err
        toast(err, 'error')
        break
      }

      if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
        const err = `文件 "${file.name}" 格式不支持，仅支持 PNG 或 JPEG 图片`
        inlineUploadError.value = err
        toast(err, 'error')
        continue
      }

      if (file.size > MAX_UPLOAD_IMAGE_BYTES) {
        const err = `图片 "${file.name}" 大小超出 ${formatLimitMb(MAX_UPLOAD_IMAGE_BYTES)} 限制 (${(file.size / (1024 * 1024)).toFixed(1)}MB)`
        inlineUploadError.value = err
        toast(err, 'error')
        continue
      }

      const currentTotal = stagedImages.value.reduce((sum, img) => sum + img.sizeBytes, 0)
      if (currentTotal + file.size > MAX_UPLOAD_TOTAL_BYTES) {
        const err = `参考图总大小不能超过 ${formatLimitMb(MAX_UPLOAD_TOTAL_BYTES)}`
        inlineUploadError.value = err
        toast(err, 'error')
        break
      }

      const dimCheck = await checkImageDimensions(file)
      if (!dimCheck.valid) {
        const err = `图片 "${file.name}": ${dimCheck.error}`
        inlineUploadError.value = err
        toast(err, 'error')
        continue
      }

      const currentMaxAllowed = Math.min(modelMaxInputImages.value, MAX_INPUT_IMAGES)
      const postValidationTotal = stagedImages.value.reduce((sum, image) => sum + image.sizeBytes, 0)
      if (
        !isModelSupportingImages.value ||
        stagedImages.value.length >= currentMaxAllowed ||
        postValidationTotal + file.size > MAX_UPLOAD_TOTAL_BYTES
      ) {
        const err = !isModelSupportingImages.value
          ? '当前模型不支持参考图'
          : stagedImages.value.length >= currentMaxAllowed
            ? `最多支持添加 ${currentMaxAllowed} 张参考图`
            : `参考图总大小不能超过 ${formatLimitMb(MAX_UPLOAD_TOTAL_BYTES)}`
        inlineUploadError.value = err
        toast(err, 'error')
        break
      }

      const localId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const previewUrl = URL.createObjectURL(file)
      const staged: StagedReferenceImage = {
        localId,
        file,
        previewUrl,
        status: 'pending',
        progress: 0,
        mimeType: file.type,
        sizeBytes: file.size,
        width: dimCheck.width,
        height: dimCheck.height,
        role: 'reference_image',
      }

      stagedImages.value.push(staged)
      startUpload(staged)
    }
  }

  async function startUpload(img: StagedReferenceImage) {
    img.status = 'uploading'
    img.progress = 0
    img.error = undefined
    refreshInlineUploadError()

    const presignRes = await api<PresignedUploadResponse>('/api/generation-uploads', {
      method: 'POST',
      body: {
        mimeType: img.mimeType,
        sizeBytes: img.sizeBytes,
      },
    })

    if (!stagedImages.value.includes(img)) {
      if (presignRes.success && presignRes.data) {
        await api(`/api/generation-uploads/${presignRes.data.id}`, { method: 'DELETE' })
      }
      return
    }

    if (!presignRes.success || !presignRes.data) {
      img.status = 'error'
      img.error = presignRes.error?.message || '获取上传地址失败'
      inlineUploadError.value = img.error
      toast(img.error, 'error')
      return
    }

    img.uploadId = presignRes.data.id
    const { uploadUrl, fields } = presignRes.data

    const { promise, resolve } = Promise.withResolvers<void>()
    const xhr = new XMLHttpRequest()
    img.xhr = xhr

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        img.progress = Math.min(99, Math.round((event.loaded / event.total) * 100))
      }
    }

    xhr.onload = async () => {
      if (!stagedImages.value.includes(img)) {
        resolve()
        return
      }
      img.xhr = undefined
      if (xhr.status >= 200 && xhr.status < 300) {
        img.progress = 100
        img.status = 'processing'
        const completeRes = await api<UploadCompleteResponse>(
          `/api/generation-uploads/${img.uploadId}/complete`,
          { method: 'POST' }
        )
        if (!stagedImages.value.includes(img)) {
          resolve()
          return
        }
        if (completeRes.success && completeRes.data) {
          img.status = 'ready'
          img.imageUrl = completeRes.data.imageUrl
          img.width = completeRes.data.width
          img.height = completeRes.data.height
          refreshInlineUploadError()
        } else {
          img.status = 'error'
          img.error = completeRes.error?.message || '上传确认失败'
          inlineUploadError.value = img.error
          toast(img.error, 'error')
        }
      } else {
        img.status = 'error'
        img.error = `上传至存储服务失败 (HTTP ${xhr.status})`
        inlineUploadError.value = img.error
        toast(img.error, 'error')
      }
      resolve()
    }

    xhr.onerror = () => {
      if (!stagedImages.value.includes(img)) {
        resolve()
        return
      }
      img.xhr = undefined
      img.status = 'error'
      img.error = '网络连接错误，文件上传失败'
      inlineUploadError.value = img.error
      toast(img.error, 'error')
      resolve()
    }

    xhr.onabort = () => {
      img.xhr = undefined
      resolve()
    }

    const formData = new FormData()
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        formData.append(k, v)
      }
    }
    formData.append('file', img.file)

    xhr.open('POST', uploadUrl)
    xhr.send(formData)
    await promise
  }

  function removeStagedImage(localId: string) {
    const idx = stagedImages.value.findIndex((img) => img.localId === localId)
    if (idx < 0) return
    const [removed] = stagedImages.value.splice(idx, 1)
    if (removed.xhr) {
      try {
        removed.xhr.abort()
      } catch {
        // The request may already have completed.
      }
    }
    if (removed.uploadId) {
      api(`/api/generation-uploads/${removed.uploadId}`, { method: 'DELETE' }).catch(() => {})
    }
    try {
      URL.revokeObjectURL(removed.previewUrl)
    } catch {
      // The browser may have already released the URL.
    }
    refreshInlineUploadError()
  }

  async function retryUpload(localId: string) {
    const img = stagedImages.value.find((candidate) => candidate.localId === localId)
    if (!img) return

    const previousUploadId = img.uploadId
    img.uploadId = undefined
    if (previousUploadId) {
      await api(`/api/generation-uploads/${previousUploadId}`, { method: 'DELETE' })
    }
    if (!stagedImages.value.includes(img)) return
    await startUpload(img)
  }

  function reorderStagedImages(fromIndex: number, toIndex: number) {
    if (
      fromIndex < 0 ||
      fromIndex >= stagedImages.value.length ||
      toIndex < 0 ||
      toIndex >= stagedImages.value.length
    ) {
      return
    }
    const item = stagedImages.value.splice(fromIndex, 1)[0]
    stagedImages.value.splice(toIndex, 0, item)
  }

  function clearStagedImages(deleteRemote = true) {
    for (const img of stagedImages.value) {
      if (img.xhr) {
        try {
          img.xhr.abort()
        } catch {
          // The request may already have completed.
        }
      }
      if (deleteRemote && img.uploadId) {
        api(`/api/generation-uploads/${img.uploadId}`, { method: 'DELETE' }).catch(() => {})
      }
      try {
        URL.revokeObjectURL(img.previewUrl)
      } catch {
        // The browser may have already released the URL.
      }
    }
    stagedImages.value = []
    inlineUploadError.value = null
  }

  function removeJobLocally(id: string) {
    const idx = jobs.value.findIndex((j) => j.id === id)
    if (idx < 0) return

    jobs.value.splice(idx, 1)

    if (selectedJobId.value === id) {
      selectedJobId.value = jobs.value[idx]?.id || jobs.value[idx - 1]?.id || null
    }
  }

  // Keep form state aligned with the active model's supported options.
  watch(selectedModel, (model) => {
    if (!model) {
      return
    }

    if (!model.sizes.includes(selectedSize.value)) {
      selectedSize.value = model.sizes[0] || '1024x1024'
    }
    const qualities = model.qualityOptions || []
    if (qualities.length && !qualities.includes(selectedQuality.value)) {
      selectedQuality.value = qualities[0]
    }
    if (count.value > model.maxCount) count.value = model.maxCount
    if (count.value < 1) count.value = 1
    if (isVideoModel(model)) {
      const normalized = normalizeVideoControls(model, {
        durationSeconds: videoDuration.value,
        aspectRatio: videoAspectRatio.value,
        resolution: videoResolution.value,
        audio: videoAudio.value,
        count: count.value,
      })
      videoDuration.value = normalized.durationSeconds
      videoAspectRatio.value = normalized.aspectRatio
      videoResolution.value = normalized.resolution
      videoAudio.value = normalized.audio
      count.value = normalized.count
    }
  }, { immediate: true })
  async function fetchModels() {
    const [, , res] = await Promise.all([
      accountStore.fetchBillingSettings(),
      accountStore.fetchCredits(),
      api<ModelConfig[]>('/api/models'),
    ])
    if (res.success && res.data) {
      models.value = res.data
      if (res.data.length && !selectedModelId.value) {
        selectedModelId.value = res.data[0].id
        selectedSize.value = '1024x1024'
        selectedQuality.value = 'auto'
      }
    }
    return res
  }

  async function fetchJobs() {
    const res = await api<{ items: GenerationJob[] }>('/api/jobs')
    if (res.success && res.data) {
      jobs.value = res.data.items
      if (selectedJobId.value && !jobs.value.some((job) => job.id === selectedJobId.value)) {
        selectedJobId.value = jobs.value[0]?.id || null
      }
    }
  }

  async function createJob() {
    const model = selectedModel.value
    if (!prompt.value.trim() || !selectedModelId.value) return
    if (model && !isVideoModel(model) && !selectedSize.value) return
    if (!canSubmitWithImages.value) return
    if (!accountStore.billingSettingsLoaded) {
      return { success: false, error: { code: 'BILLING_NOT_LOADED', message: '计费配置加载中，请稍后重试' } }
    }
    if (isBillingEnabled.value && (!accountStore.creditsLoaded || !accountStore.creditBalance)) {
      return { success: false, error: { code: 'CREDITS_NOT_LOADED', message: '积分余额加载中，请稍后重试' } }
    }
    if (!hasSufficientCredits.value) {
      return { success: false, error: { code: 'INSUFFICIENT_CREDITS', message: '积分余额不足' } }
    }
    loading.value = true
    const video = model ? isVideoModel(model) : false
    const parameters: Record<string, unknown> = video
      ? buildVideoParameters(normalizeVideoControls(model, {
        durationSeconds: videoDuration.value,
        aspectRatio: videoAspectRatio.value,
        resolution: videoResolution.value,
        audio: videoAudio.value,
        count: count.value,
      }))
      : buildImageParameters({ size: selectedSize.value, quality: selectedQuality.value, count: count.value })
    const inputs = buildGenerationInputs(stagedImages.value)
    const requestBody: Record<string, unknown> = {
      prompt: prompt.value.trim(),
      modelId: selectedModelId.value,
      parameters,
      inputs,
      // Legacy compatibility path for existing image clients/servers.
      size: selectedSize.value,
      quality: selectedQuality.value,
      count: count.value,
      inputImageIds: inputs.map((item) => item.uploadId),
    }

    if (isBillingEnabled.value) {
      requestBody.expectedCredits = estimatedCredits.value
    }

    const res = await api<GenerationJob>('/api/generations', {
      method: 'POST',
      body: requestBody,
    })
    loading.value = false

    if (res.success && res.data) {
      jobs.value.unshift(res.data)
      selectedJobId.value = res.data.id
      prompt.value = ''
      clearStagedImages(false)
      accountStore.fetchCredits().catch(() => {})
      return res
    } else {
      if (res.error?.code === 'INSUFFICIENT_CREDITS') {
        accountStore.fetchCredits().catch(() => {})
      } else if (res.error?.code === 'GENERATION_PRICE_CHANGED') {
        fetchModels().catch(() => {})
        accountStore.fetchBillingSettings().catch(() => {})
        accountStore.fetchCredits().catch(() => {})
      }
    }
    return res
  }
  async function cancelJob(id: string) {
    const res = await api<GenerationJob>(`/api/jobs/${id}/cancel`, { method: 'POST' })
    if (res.success && res.data) {
      const idx = jobs.value.findIndex((j) => j.id === id)
      if (idx >= 0) jobs.value[idx] = res.data
      accountStore.fetchCredits().catch(() => {})
    }
    return res
  }

  async function retryJob(id: string) {
    const res = await api<GenerationJob>(`/api/jobs/${id}/retry`, { method: 'POST' })
    if (res.success && res.data) {
      const idx = jobs.value.findIndex((j) => j.id === id)
      if (idx >= 0) jobs.value[idx] = res.data
      else jobs.value.unshift(res.data)
      selectedJobId.value = res.data.id
      accountStore.fetchCredits().catch(() => {})
    } else {
      if (res.error?.code === 'INSUFFICIENT_CREDITS') {
        accountStore.fetchCredits().catch(() => {})
      } else if (res.error?.code === 'GENERATION_PRICE_CHANGED') {
        fetchModels().catch(() => {})
        accountStore.fetchBillingSettings().catch(() => {})
        accountStore.fetchCredits().catch(() => {})
      }
    }
    return res
  }

  async function deleteJob(id: string) {
    const res = await api(`/api/jobs/${id}`, { method: 'DELETE' })
    if (res.success) {
      removeJobLocally(id)
      await useLibraryStore().fetchAssets()
    }
    return res
  }

  async function refreshJob(id: string) {
    const prevJob = jobs.value.find((j) => j.id === id)
    const prevStatusTerminal = prevJob ? ['succeeded', 'failed', 'canceled'].includes(prevJob.status) : false
    const prevBillingTerminal = prevJob ? (prevJob.billingState === 'settled' || prevJob.billingState === 'released') : false

    const res = await api<GenerationJob>(`/api/jobs/${id}`)
    if (res.success && res.data) {
      const newJob = res.data
      const idx = jobs.value.findIndex((j) => j.id === id)
      if (idx >= 0) jobs.value[idx] = newJob

      const newStatusTerminal = ['succeeded', 'failed', 'canceled'].includes(newJob.status)
      const newBillingTerminal = newJob.billingState === 'settled' || newJob.billingState === 'released'

      const becameTerminal = (!prevStatusTerminal && newStatusTerminal) || (!prevBillingTerminal && newBillingTerminal)
      if (becameTerminal) {
        accountStore.fetchCredits().catch(() => {})
      }
    } else if (res.error?.code === 'NOT_FOUND') {
      removeJobLocally(id)
    }
    return res
  }
  function setStagedImageRole(localId: string, role: StagedInputRole) {
    const img = stagedImages.value.find((candidate) => candidate.localId === localId)
    if (img) img.role = role
  }

  return {
    models, jobs, selectedJobId, loading,
    prompt, selectedModelId, selectedSize, selectedQuality, count,
    videoDuration, videoAspectRatio, videoResolution, videoAudio,
    isVideo, inputSlots, videoDurations, videoAspectRatios, videoResolutions, normalizedVideo,
    selectedModel, selectedJob, availableSizes, availableQualities, maxCount,
    stagedImages, inlineUploadError, stagedImagesValidationError, canSubmitWithImages,
    modelMaxInputImages, isModelSupportingImages, stagedImagesCount, stagedImagesTotalBytes,
    isBillingReady, isBillingEnabled, estimatedCredits, hasSufficientCredits,
    addStagedFiles, removeStagedImage, retryUpload, reorderStagedImages, clearStagedImages,
    setStagedImageRole,
    fetchModels, fetchJobs, createJob, cancelJob, retryJob, deleteJob, refreshJob,
  }
})
