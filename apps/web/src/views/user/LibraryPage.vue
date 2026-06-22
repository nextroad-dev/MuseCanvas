<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLibraryStore } from '@/stores/library'
import ImageCard from '@/components/ui/ImageCard.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import type { Asset } from '@/types'

const library = useLibraryStore()
const previewAsset = ref<Asset | null>(null)
const deleteTarget = ref<Asset | null>(null)
const showDeleteConfirm = ref(false)

onMounted(() => {
  library.fetchAssets()
})

function handleView(asset: Asset) {
  previewAsset.value = asset
}

function handleDownload(asset: Asset) {
  const a = document.createElement('a')
  a.href = asset.imageUrl
  a.download = `musecanvas-${asset.id}.png`
  a.click()
}

function handleDelete(asset: Asset) {
  deleteTarget.value = asset
  showDeleteConfirm.value = true
}

function confirmDelete() {
  if (deleteTarget.value) {
    library.deleteAsset(deleteTarget.value.id)
  }
  showDeleteConfirm.value = false
  deleteTarget.value = null
}
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <!-- Toolbar -->
    <div class="flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 px-6">
      <h2 class="text-sm font-semibold text-neutral-900">图库</h2>
      <span class="text-xs text-neutral-500">{{ library.assets.length }} 张图片</span>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-auto p-6">
      <EmptyState
        v-if="!library.loading && library.assets.length === 0"
        title="还没有生成图片"
        description="去创作你的第一张 AI 图片吧"
        @action="$router.push('/generate')"
      >
        <template #action-label>去创作</template>
      </EmptyState>

      <!-- Loading skeleton -->
      <div v-else-if="library.loading" class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        <div
          v-for="i in 8"
          :key="i"
          class="animate-pulse rounded-xl border border-neutral-200 bg-neutral-100"
        >
          <div class="aspect-square bg-neutral-200" />
          <div class="px-3 py-2.5">
            <div class="h-3 w-3/4 rounded bg-neutral-200" />
          </div>
        </div>
      </div>

      <!-- Image grid -->
      <div v-else class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        <ImageCard
          v-for="asset in library.assets"
          :key="asset.id"
          :asset="asset"
          @view="handleView"
          @download="handleDownload"
          @delete="handleDelete"
        />
      </div>
    </div>

    <!-- Full-screen preview -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="previewAsset" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80" @click="previewAsset = null">
          <div class="relative max-h-[90vh] max-w-[90vw]">
            <img :src="previewAsset.imageUrl" :alt="previewAsset.prompt" class="max-h-[85vh] rounded-lg shadow-2xl" />
            <p class="mt-3 max-w-lg text-center text-xs text-white/70">{{ previewAsset.prompt }}</p>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Delete confirmation -->
    <ConfirmDialog
      v-model:open="showDeleteConfirm"
      title="删除图片"
      description="此操作不可撤销，图片将从图库中永久移除。"
      confirm-text="删除"
      variant="danger"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
