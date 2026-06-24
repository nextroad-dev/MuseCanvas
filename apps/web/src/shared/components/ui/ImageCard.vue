<script setup lang="ts">
import { computed } from 'vue'
import { Trash2, Download, Maximize2 } from 'lucide-vue-next'
import type { Asset } from '@/shared/types'

const props = withDefaults(defineProps<{
  asset: Asset
  density?: 'compact' | 'comfortable' | 'spacious'
  photoSize?: 'small' | 'medium' | 'large' | 'xlarge'
}>(), {
  density: 'comfortable',
  photoSize: 'medium',
})

defineEmits<{
  view: [asset: Asset]
  download: [asset: Asset]
  delete: [asset: Asset]
}>()

const densityClasses = computed(() => {
  if (props.density === 'compact') {
    return {
      container: 'rounded-lg',
      action: 'h-8 w-8',
      icon: 'h-4 w-4',
    }
  }

  if (props.density === 'spacious') {
    return {
      container: 'rounded-2xl',
      action: 'h-10 w-10',
      icon: 'h-5 w-5',
    }
  }

  return {
    container: 'rounded-xl',
    action: 'h-9 w-9',
    icon: 'h-4 w-4',
  }
})

const aspectClass = computed(() => {
  if (props.photoSize === 'small') return 'aspect-[4/3]'
  if (props.photoSize === 'large') return 'aspect-[3/4]'
  if (props.photoSize === 'xlarge') return 'aspect-[2/3]'
  return 'aspect-square'
})
</script>

<template>
  <div
    class="group relative cursor-pointer overflow-hidden border border-neutral-200 bg-white transition-shadow hover:shadow-md"
    :class="densityClasses.container"
    @click="$emit('view', asset)"
  >
    <!-- Image -->
    <div class="overflow-hidden bg-neutral-100" :class="aspectClass">
      <img
        :src="asset.imageUrl"
        :alt="asset.prompt"
        class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        loading="lazy"
      />
    </div>

    <!-- Hover overlay: prompt + actions -->
    <div
      class="absolute inset-0 flex flex-col justify-end opacity-0 transition-opacity duration-200 group-hover:opacity-100"
    >
      <!-- Gradient mask -->
      <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />

      <!-- Actions -->
      <div class="relative z-10 flex items-center justify-center gap-2 pb-3">
        <button
          :class="[
            'flex items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow-sm transition-colors hover:bg-white hover:text-neutral-950',
            densityClasses.action,
          ]"
          @click.stop="$emit('view', asset)"
        >
          <Maximize2 :class="densityClasses.icon" />
        </button>
        <button
          :class="[
            'flex items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow-sm transition-colors hover:bg-white hover:text-neutral-950',
            densityClasses.action,
          ]"
          @click.stop="$emit('download', asset)"
        >
          <Download :class="densityClasses.icon" />
        </button>
        <button
          :class="[
            'flex items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow-sm transition-colors hover:bg-white hover:text-danger',
            densityClasses.action,
          ]"
          @click.stop="$emit('delete', asset)"
        >
          <Trash2 :class="densityClasses.icon" />
        </button>
      </div>

      <!-- Prompt -->
      <div class="relative z-10 px-3 pb-4 pt-1">
        <p class="text-xs leading-relaxed text-white/90 line-clamp-2">
          {{ asset.prompt }}
        </p>
      </div>
    </div>
  </div>
</template>
