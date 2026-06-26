import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { GenerationJob, ModelConfig, Quality } from '@/shared/types'
import { api } from '@/shared/services/api'
import { useLibraryStore } from '@/features/library/stores/library'

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

  const selectedModel = computed(() => models.value.find((m) => m.id === selectedModelId.value))
  const selectedJob = computed(() => jobs.value.find((j) => j.id === selectedJobId.value))

  const availableSizes = computed(() => selectedModel.value?.sizes || [])
  const availableQualities = computed(() => selectedModel.value?.qualityOptions || [])
  const maxCount = computed(() => selectedModel.value?.maxCount || 1)

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
  }, { immediate: true })

  async function fetchModels() {
    const res = await api<ModelConfig[]>('/api/models')
    if (res.success && res.data) {
      models.value = res.data
      if (res.data.length && !selectedModelId.value) {
        selectedModelId.value = res.data[0].id
        selectedSize.value = '1024x1024'
        selectedQuality.value = 'auto'
      }
    }
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
    if (!prompt.value.trim() || !selectedModelId.value || !selectedSize.value) return

    loading.value = true
    const res = await api<GenerationJob>('/api/generations', {
      method: 'POST',
      body: {
        prompt: prompt.value.trim(),
        modelId: selectedModelId.value,
        size: selectedSize.value,
        quality: selectedQuality.value,
        count: count.value,
      },
    })
    loading.value = false

    if (res.success && res.data) {
      jobs.value.unshift(res.data)
      selectedJobId.value = res.data.id
      prompt.value = ''
      return res
    }
    return res
  }

  async function cancelJob(id: string) {
    const res = await api<GenerationJob>(`/api/jobs/${id}/cancel`, { method: 'POST' })
    if (res.success && res.data) {
      const idx = jobs.value.findIndex((j) => j.id === id)
      if (idx >= 0) jobs.value[idx] = res.data
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
    const res = await api<GenerationJob>(`/api/jobs/${id}`)
    if (res.success && res.data) {
      const idx = jobs.value.findIndex((j) => j.id === id)
      if (idx >= 0) jobs.value[idx] = res.data
    } else if (res.error?.code === 'NOT_FOUND') {
      removeJobLocally(id)
    }
    return res
  }

  return {
    models, jobs, selectedJobId, loading,
    prompt, selectedModelId, selectedSize, selectedQuality, count,
    selectedModel, selectedJob, availableSizes, availableQualities, maxCount,
    fetchModels, fetchJobs, createJob, cancelJob, retryJob, deleteJob, refreshJob,
  }
})
