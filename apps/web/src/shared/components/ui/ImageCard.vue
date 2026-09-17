<script setup lang="ts">
import { computed } from 'vue'
import { Trash2, Download, Maximize2 } from 'lucide-vue-next'
import type { Asset } from '@/shared/types'
import { assetPlaybackUrl, isVideoAsset } from '@/shared/types'
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
      container: 'rounded-[var(--radius-control)]',
      action: 'h-8 w-8',
      icon: 'h-4 w-4',
    }
  }

  if (props.density === 'spacious') {
    return {
      container: 'rounded-[var(--radius-card)]',
      action: 'h-10 w-10',
      icon: 'h-5 w-5',
    }
  }

  return {
    container: 'rounded-[var(--radius-card)]',
    action: 'h-9 w-9',
    icon: 'h-4 w-4',
  }
})

const playbackUrl = computed(() => assetPlaybackUrl(props.asset))
const showVideo = computed(() => isVideoAsset(props.asset))

const aspectClass = computed(() => {
  if (props.photoSize === 'small') return 'aspect-[4/3]'
  if (props.photoSize === 'large') return 'aspect-[3/4]'
  if (props.photoSize === 'xlarge') return 'aspect-[2/3]'
  return 'aspect-square'
})
</script>

<template>
  <div
    class="group relative overflow-hidden border border-border bg-surface"
    :class="densityClasses.container"
  >
    <!-- Media -->
    <button
      type="button"
      class="relative block w-full cursor-zoom-in overflow-hidden bg-surface-subtle"
      :class="aspectClass"
      :aria-label="`查看作品大图：${asset.prompt}`"
      @click="$emit('view', asset)"
    >
      <video
        v-if="showVideo"
        :src="playbackUrl"
        :poster="asset.posterUrl || undefined"
        preload="metadata"
        muted
        playsinline
        class="h-full w-full object-cover"
      />
      <img
        v-else
        :src="asset.imageUrl"
        :alt="asset.prompt"
        class="h-full w-full object-cover"
        loading="lazy"
      />
      <span v-if="showVideo" class="absolute left-2 top-2 rounded-[var(--radius-control)] bg-overlay/65 px-1.5 py-0.5 text-xs font-medium text-foreground-inverse">视频</span>
    </button>

    <!-- Overlay: prompt + actions. Reachable with pointer, keyboard and touch
         (always visible on narrow viewports, opacity-only transitions). -->
    <div
      class="pointer-events-none absolute inset-0 flex flex-col justify-end opacity-100 transition-opacity duration-[var(--motion-base)] md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
    >
      <!-- Functional scrim for prompt legibility -->
      <div class="media-scrim absolute inset-0" aria-hidden="true"/>

      <!-- Actions -->
      <div class="relative z-10 flex items-center justify-center gap-2 pb-3">
        <button
          type="button"
          :class="[
            'pointer-events-auto flex items-center justify-center rounded-full bg-foreground-inverse text-foreground transition-colors hover:bg-surface-subtle',
            densityClasses.action,
          ]"
          :aria-label="`查看作品大图：${asset.prompt}`"
          @click.stop="$emit('view', asset)"
        >
          <Maximize2 :class="densityClasses.icon" aria-hidden="true"/>
        </button>
        <button
          type="button"
          :class="[
            'pointer-events-auto flex items-center justify-center rounded-full bg-foreground-inverse text-foreground transition-colors hover:bg-surface-subtle',
            densityClasses.action,
          ]"
          :aria-label="`下载作品：${asset.prompt}`"
          @click.stop="$emit('download', asset)"
        >
          <Download :class="densityClasses.icon" aria-hidden="true"/>
        </button>
        <button
          type="button"
          :class="[
            'pointer-events-auto flex items-center justify-center rounded-full bg-foreground-inverse text-danger transition-colors hover:bg-danger-soft',
            densityClasses.action,
          ]"
          :aria-label="`删除作品：${asset.prompt}`"
          @click.stop="$emit('delete', asset)"
        >
          <Trash2 :class="densityClasses.icon" aria-hidden="true"/>
        </button>
      </div>

      <!-- Prompt -->
      <div class="relative z-10 px-3 pb-4 pt-1">
        <p class="line-clamp-2 text-xs leading-relaxed text-foreground-inverse">
          {{ asset.prompt }}
        </p>
      </div>
    </div>
  </div>
</template>