<script setup lang="ts">
import { computed } from 'vue'
import type { ModelConfig } from '@/shared/types'
import SelectPopover from '@/shared/components/ui/SelectPopover.vue'

const props = defineProps<{
  models: ModelConfig[]
  modelValue: string
  open: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:open': [value: boolean]
}>()

const selectedModel = computed(() => props.models.find(m => m.id === props.modelValue))

function select(id: string) {
  emit('update:modelValue', id)
  emit('update:open', false)
}
</script>

<template>
  <SelectPopover
    :open="open"
    :disabled="disabled"
    panel-class="left-0 top-full z-popover mt-1.5 w-72 p-2"
    @update:open="emit('update:open', $event)"
  >
    <template #trigger-label>{{ selectedModel?.displayName || '选择模型' }}</template>
    <template #default>
      <div class="px-3 pb-2 text-xs font-medium text-muted-foreground">选择模型</div>
      <div class="max-h-64 overflow-auto flex flex-col gap-1">
        <button
          v-for="model in models"
          :key="model.id"
          type="button"
          class="flex w-full items-center rounded-[var(--radius-control)] px-3 py-2 text-left transition-colors hover:bg-surface-subtle"
          :class="model.id === modelValue ? 'bg-primary-soft text-primary' : 'text-foreground'"
          @click="select(model.id)"
        >
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-1.5 text-sm font-medium">
              <span class="truncate">{{ model.displayName }}</span>
              <span
                v-if="model.modelKind === 'video' || (model as any).mediaKind === 'video'"
                class="shrink-0 rounded bg-primary-soft px-1.5 py-0.5 text-[11px] font-semibold text-primary"
              >视频</span>
              <span
                v-else-if="model.modelKind === 'language'"
                class="shrink-0 rounded bg-surface-subtle px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
              >语言</span>
            </p>
          </div>
          <span class="ml-2 shrink-0 rounded bg-surface-subtle px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {{ model.pricing?.scheme === 'per_second_v1' ? `${(model.pricing as any).creditsPerSecond} 积分/秒` : `${model.creditsPerImage ?? 0} 积分/${model.modelKind === 'video' ? '次' : '张'}` }}
          </span>
        </button>
      </div>
    </template>
  </SelectPopover>
</template>
