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
    popup-label="选择模型"
    panel-class="w-72"
    @update:open="emit('update:open', $event)"
  >
    <template #trigger-label>{{ selectedModel?.displayName || '选择模型' }}</template>
    <template #default>
      <div class="max-h-64 overflow-auto flex flex-col gap-1" role="listbox" aria-label="选择模型">
        <button
          v-for="model in models"
          :key="model.id"
          type="button"
          role="option"
          data-menu-item
          tabindex="-1"
          :aria-selected="model.id === modelValue"
          class="flex min-h-10 w-full items-center rounded-[var(--radius-control)] px-3 text-left transition-colors hover:bg-surface-subtle"
          :class="model.id === modelValue ? 'bg-accent-soft text-accent-strong' : 'text-foreground'"
          @click="select(model.id)"
        >
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-1.5 text-sm font-medium">
              <span class="truncate">{{ model.displayName }}</span>
              <span
                v-if="model.modelKind === 'video' || (model as any).mediaKind === 'video'"
                class="shrink-0 rounded-[var(--radius-control)] bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent-strong"
              >视频</span>
              <span
                v-else-if="model.modelKind === 'language'"
                class="shrink-0 rounded-[var(--radius-control)] bg-surface-subtle px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
              >语言</span>
            </p>
          </div>
          <span class="ml-2 shrink-0 rounded-[var(--radius-control)] bg-surface-subtle px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
            {{ model.pricing?.scheme === 'per_second_v1' ? `${(model.pricing as any).creditsPerSecond} 积分/秒` : `${model.creditsPerImage ?? 0} 积分/${model.modelKind === 'video' ? '次' : '张'}` }}
          </span>
        </button>
      </div>
    </template>
  </SelectPopover>
</template>
