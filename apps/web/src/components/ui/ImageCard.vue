<script setup lang="ts">
import { Trash2, Download, Maximize2 } from 'lucide-vue-next'
import type { Asset } from '@/types'

defineProps<{
  asset: Asset
}>()

defineEmits<{
  view: [asset: Asset]
  download: [asset: Asset]
  delete: [asset: Asset]
}>()
</script>

<template>
  <div class="group relative overflow-hidden rounded-xl border border-neutral-200 bg-white transition-shadow hover:shadow-sm">
    <!-- Image -->
    <div class="aspect-square overflow-hidden bg-neutral-100">
      <img
        :src="asset.imageUrl"
        :alt="asset.prompt"
        class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        loading="lazy"
      />
    </div>

    <!-- Prompt -->
    <div class="px-3 py-2.5">
      <p class="line-clamp-2 text-xs text-neutral-600">{{ asset.prompt }}</p>
    </div>

    <!-- Hover actions -->
    <div class="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <button
        class="flex h-7 w-7 items-center justify-center rounded-lg bg-white/90 text-neutral-600 shadow-sm transition-colors hover:bg-white hover:text-neutral-950"
        title="查看大图"
        @click="$emit('view', asset)"
      >
        <Maximize2 class="h-3.5 w-3.5" />
      </button>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-lg bg-white/90 text-neutral-600 shadow-sm transition-colors hover:bg-white hover:text-neutral-950"
        title="下载"
        @click="$emit('download', asset)"
      >
        <Download class="h-3.5 w-3.5" />
      </button>
      <button
        class="flex h-7 w-7 items-center justify-center rounded-lg bg-white/90 text-neutral-600 shadow-sm transition-colors hover:bg-white hover:text-danger"
        title="删除"
        @click="$emit('delete', asset)"
      >
        <Trash2 class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
