<script setup lang="ts">
import { computed } from 'vue'
import { Image as ImageIcon } from 'lucide-vue-next'
import { cn } from '@/shared/lib/utils'
import StatusBadge from '@/shared/components/ui/StatusBadge.vue'
import type { GenerationJob } from '@/shared/types'

interface Props {
  job: GenerationJob
  selected?: boolean
  compact?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  select: [id: string]
}>()

const titleText = computed(() => props.job.title || props.job.inputPrompt || props.job.prompt || '未命名任务')
const firstOutput = computed(() => props.job.outputs?.[0])
</script>

<template>
  <button
    :class="cn(
      'group flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors',
      selected
        ? 'border-l-[3px] border-l-primary bg-primary-soft'
        : 'border-l-[3px] border-l-transparent hover:bg-surface-subtle',
    )"
    :aria-current="selected ? 'true' : undefined"
    @click="emit('select', job.id)"
    @keydown.enter.prevent="emit('select', job.id)"
    @keydown.space.prevent="emit('select', job.id)"
  >
    <!-- Thumbnail -->
    <div class="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)] bg-surface-subtle">
      <video
        v-if="firstOutput?.mediaKind === 'video'"
        :src="firstOutput.url || firstOutput.imageUrl"
        preload="metadata"
        muted
        playsinline
        class="h-full w-full object-cover"
      />
      <img
        v-else-if="firstOutput && (firstOutput.url || firstOutput.imageUrl)"
        :src="firstOutput.url || firstOutput.imageUrl"
        alt=""
        class="h-full w-full object-cover"
        loading="lazy"
      />
      <ImageIcon v-else class="h-4 w-4 text-muted-foreground" />
      <span v-if="firstOutput?.mediaKind === 'video'" class="absolute bottom-0.5 right-0.5 rounded bg-black/65 px-1 text-[9px] font-semibold text-white">视频</span>
    </div>

    <!-- Info -->
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm text-foreground">{{ titleText }}</p>
      <div class="mt-1 flex items-center gap-2">
        <StatusBadge :status="job.status" variant="soft" />
        <span class="text-[10px] text-muted-foreground tabular-nums">
          {{ new Date(job.createdAt).toLocaleDateString('zh-CN') }}
        </span>
      </div>
    </div>
  </button>
</template>
