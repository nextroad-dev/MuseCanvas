import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { GenerationJob, ModelConfig, Quality } from '@/types'
import { api } from '@/services/api'

export const useGenerationStore = defineStore('generation', () => {
  const models = ref<ModelConfig[]>([])
  const jobs = ref<GenerationJob[]>([])
  const selectedJobId = ref<string | null>(null)
  const loading = ref(false)

  // Form state
  const prompt = ref('')
  const selectedModelId = ref('')
  const selectedSize = ref('')
  const selectedQuality = ref<Quality | ''>('')
  const count = ref(1)

  const selectedModel = computed(() => models.value.find((m) => m.id === selectedModelId.value))
  const selectedJob = computed(() => jobs.value.find((j) => j.id === selectedJobId.value))

  const availableSizes = computed(() => selectedModel.value?.sizes || [])
  const availableQualities = computed(() => selectedModel.value?.qualityOptions || [])

  async function fetchModels() {
    const res = await api<ModelConfig[]>('/api/models')
    if (res.success && res.data) {
      models.value = res.data
      if (res.data.length && !selectedModelId.value) {
        selectedModelId.value = res.data[0].id
        selectedSize.value = res.data[0].sizes[0] || ''
        if (res.data[0].qualityOptions?.length) {
          selectedQuality.value = res.data[0].qualityOptions[0]
        }
      }
    }
  }

  async function fetchJobs() {
    const res = await api<{ items: GenerationJob[] }>('/api/jobs')
    if (res.success && res.data) {
      jobs.value = res.data.items
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
        quality: selectedQuality.value || undefined,
        count: count.value,
      },
    })
    loading.value = false

    if (res.success && res.data) {
      jobs.value.unshift(res.data)
      selectedJobId.value = res.data.id
      prompt.value = ''
      return res.data
    }
    return null
  }

  async function cancelJob(id: string) {
    const res = await api<GenerationJob>(`/api/jobs/${id}/cancel`, { method: 'POST' })
    if (res.success && res.data) {
      const idx = jobs.value.findIndex((j) => j.id === id)
      if (idx >= 0) jobs.value[idx] = res.data
    }
  }

  async function refreshJob(id: string) {
    const res = await api<GenerationJob>(`/api/jobs/${id}`)
    if (res.success && res.data) {
      const idx = jobs.value.findIndex((j) => j.id === id)
      if (idx >= 0) jobs.value[idx] = res.data
    }
  }

  return {
    models, jobs, selectedJobId, loading,
    prompt, selectedModelId, selectedSize, selectedQuality, count,
    selectedModel, selectedJob, availableSizes, availableQualities,
    fetchModels, fetchJobs, createJob, cancelJob, refreshJob,
  }
})
