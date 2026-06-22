import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Asset } from '@/types'
import { api } from '@/services/api'

export const useLibraryStore = defineStore('library', () => {
  const assets = ref<Asset[]>([])
  const loading = ref(false)

  async function fetchAssets() {
    loading.value = true
    const res = await api<{ items: Asset[] }>('/api/library')
    loading.value = false
    if (res.success && res.data) {
      assets.value = res.data.items
    }
  }

  async function deleteAsset(id: string) {
    const res = await api(`/api/library/${id}`, { method: 'DELETE' })
    if (res.success) {
      assets.value = assets.value.filter((a) => a.id !== id)
    }
    return res
  }

  return { assets, loading, fetchAssets, deleteAsset }
})
